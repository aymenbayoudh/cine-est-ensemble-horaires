#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup, Tag

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)

DAY_KEYS = ["wed", "thu", "fri", "sat", "sun", "mon", "tue"]
DAY_LABELS = {
    "wed": "MER.", "thu": "JEU.", "fri": "VEN.",
    "sat": "SAM.", "sun": "DIM.", "mon": "LUN.", "tue": "MAR.",
}
MONTHS_FR = {
    "janvier": 1, "janv": 1, "jan": 1,
    "février": 2, "fevrier": 2, "fév": 2, "fév.": 2,
    "mars": 3,
    "avril": 4, "avr": 4, "avr.": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7, "juil": 7, "juil.": 7,
    "août": 8, "aout": 8, "aoû": 8,
    "septembre": 9, "sept": 9, "sep": 9,
    "octobre": 10, "oct": 10,
    "novembre": 11, "nov": 11,
    "décembre": 12, "decembre": 12, "déc": 12, "dec": 12,
}
VERSION_RE = re.compile(r"\b(VF(?:STF|ST-SME| OCAP)?|VO(?:ST ?FR|STF| OCAP)?|VOST ?FR|VF OCAP|VO OCAP|MU)\b", re.I)
TIME_RE = re.compile(r"\b(\d{1,2})\s*[Hh:]\s*(\d{2})\b")
DATE_DDMMYYYY_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
DATE_DD_MONTH_RE = re.compile(r"\b(\d{1,2})\s+([A-Za-zÀ-ÿ\.]+)(?:\s+(\d{4}))?\b", re.I)
BOOKING_RE = re.compile(r"cine\.boutique/media/\d+\?showId=\d+", re.I)
WEEK_OPTION_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ERAKYS_SOURCES = [
    {"name": "Pantin", "url": "https://cine104.fr/FR/43/horaires-cinema-cine-104-pantin.html", "slug": "pantin"},
    {"name": "Bobigny", "url": "https://cine-aliceguy.fr/FR/43/horaires-cinema-alice-guy-bobigny.html", "slug": "bobigny"},
    {"name": "Montreuil", "url": "https://meliesmontreuil.fr/FR/43/horaires-cinema-le-melies-montreuil.html", "slug": "montreuil"},
    {"name": "Bondy", "url": "https://cinemalraux.fr/FR/43/horaires-cinema-andre-malraux-bondy.html", "slug": "bondy"},
    {"name": "Bagnolet", "url": "https://cinhoche.fr/FR/43/horaires-cinema-cinhoche-bagnolet.html", "slug": "bagnolet"},
]
TRIANON_SOURCE = {"name": "Romainville", "url": "https://www.cinematrianon.fr/films", "slug": "trianon"}


@dataclass
class Show:
    date: dt.date
    time: str
    version: str
    cinema: str
    booking_url: str


@dataclass
class Movie:
    title: str
    genre: str = ""
    duration: str = ""
    poster: str = ""
    info_url: str = ""
    trailer_url: str = ""
    shows: List[Show] = field(default_factory=list)


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def slug_key(value: str) -> str:
    value = normalize_space(value).lower()
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.replace("œ", "oe").replace("’", " ").replace("'", " ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def absolute(base: str, url: str) -> str:
    return urljoin(base, url) if url else ""


def parse_time(text: str) -> Optional[str]:
    m = TIME_RE.search(text or "")
    if not m:
        return None
    return f"{int(m.group(1)):02d}h{int(m.group(2)):02d}"


def normalize_duration(raw: str) -> str:
    raw = normalize_space(raw)
    m = re.search(r"(\d{1,2})h(\d{2})", raw, re.I)
    if m:
        return f"{int(m.group(1)):02d}h{int(m.group(2)):02d}"
    m = re.search(r"(\d{1,3})\s*min", raw, re.I)
    if m:
        mins = int(m.group(1))
        return f"{mins // 60:02d}h{mins % 60:02d}"
    return raw


def parse_version(text: str) -> str:
    m = VERSION_RE.search(text or "")
    if not m:
        return ""
    return normalize_space(m.group(1).upper())


def date_to_week_start(d: dt.date) -> dt.date:
    offset = (d.weekday() - 2) % 7
    return d - dt.timedelta(days=offset)


def week_days(start: dt.date) -> List[Dict[str, str]]:
    return [{
        "key": key,
        "label": f"{DAY_LABELS[key]} {(start + dt.timedelta(days=i)).day:02d}",
        "date": (start + dt.timedelta(days=i)).isoformat(),
    } for i, key in enumerate(DAY_KEYS)]


def week_label(start: dt.date) -> str:
    end = start + dt.timedelta(days=6)
    return f"Semaine du {start.strftime('%d/%m')} au {end.strftime('%d/%m')}"


def infer_year_for_month(month: int, today: dt.date) -> int:
    year = today.year
    if today.month == 12 and month == 1:
        return year + 1
    if today.month == 1 and month == 12:
        return year - 1
    return year


def parse_french_date(text: str, today: dt.date, default_year: Optional[int] = None) -> Optional[dt.date]:
    text = normalize_space(text).lower()
    m = DATE_DDMMYYYY_RE.search(text)
    if m:
        dd, mm, yyyy = map(int, m.groups())
        try:
            return dt.date(yyyy, mm, dd)
        except ValueError:
            return None
    m = DATE_DD_MONTH_RE.search(text)
    if m:
        day = int(m.group(1))
        month_txt = m.group(2).strip('. ').lower()
        month = MONTHS_FR.get(month_txt)
        if month:
            year = int(m.group(3)) if m.group(3) else (default_year or infer_year_for_month(month, today))
            try:
                return dt.date(year, month, day)
            except ValueError:
                return None
    return None


def first_text(*values: str) -> str:
    for value in values:
        value = normalize_space(value)
        if value:
            return value
    return ""


def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    })
    return s


def fetch_text(sess: requests.Session, url: str, timeout: int = 25, params: Optional[dict] = None, ajax: bool = False) -> str:
    headers = {}
    if ajax:
        headers["X-Requested-With"] = "XMLHttpRequest"
        headers["Accept"] = "text/html, */*; q=0.01"
    resp = sess.get(url, timeout=timeout, params=params, headers=headers)
    resp.raise_for_status()
    resp.encoding = resp.encoding or "utf-8"
    return resp.text


def parse_selected_week_start_from_erakys(soup: BeautifulSoup, today: dt.date) -> Optional[dt.date]:
    option = soup.select_one("#selecteurSemaine option[selected]") or soup.select_one("#selecteurSemaine option")
    if not option:
        return None
    value = normalize_space(option.get("value") or "")
    try:
        return dt.date.fromisoformat(value)
    except Exception:
        label = normalize_space(option.get_text(" ", strip=True))
        m = re.search(r"Semaine du (\d{1,2})/(\d{1,2})", label, re.I)
        if m:
            dd, mm = map(int, m.groups())
            try:
                return dt.date(infer_year_for_month(mm, today), mm, dd)
            except Exception:
                pass
    return None


def parse_available_week_starts_from_erakys(soup: BeautifulSoup, today: dt.date) -> List[dt.date]:
    starts: List[dt.date] = []
    for option in soup.select("#selecteurSemaine option"):
        value = normalize_space(option.get("value") or "")
        if WEEK_OPTION_RE.match(value):
            try:
                starts.append(dt.date.fromisoformat(value))
                continue
            except Exception:
                pass
        text = normalize_space(option.get_text(" ", strip=True))
        m = re.search(r"Semaine du (\d{1,2})/(\d{1,2})", text, re.I)
        if m:
            dd, mm = map(int, m.groups())
            try:
                starts.append(dt.date(infer_year_for_month(mm, today), mm, dd))
            except Exception:
                pass
    unique = []
    seen = set()
    for d in starts:
        if d not in seen:
            seen.add(d)
            unique.append(d)
    return unique


def get_erakys_idms(soup: BeautifulSoup) -> str:
    node = soup.select_one("#identifiantMS")
    if node:
        txt = normalize_space(node.get_text(" ", strip=True))
        if txt:
            return txt
    select = soup.select_one("#selecteurSemaine")
    if select:
        rel = normalize_space(select.get("rel") or "")
        if rel:
            return rel
    return ""


def parse_trailer_from_card(card: Tag, base_url: str) -> str:
    node = card.select_one(".openplayba")
    if not node:
        return ""
    rel = node.get("rel") or node.get("data-src") or node.get("href") or ""
    return absolute(base_url, rel)


def parse_erakys_listing_html(html: str, source: Dict[str, str], today: dt.date) -> List[Movie]:
    soup = BeautifulSoup(html, "html.parser")
    week_start = parse_selected_week_start_from_erakys(soup, today) or date_to_week_start(today)
    days = [week_start + dt.timedelta(days=i) for i in range(7)]
    movies: Dict[str, Movie] = {}

    for row in soup.select("div.row.fiche-film-div"):
        title_el = row.select_one("h3")
        if not title_el:
            continue
        title = normalize_space(title_el.get_text(" ", strip=True))
        if not title:
            continue

        genre = ""
        genre_el = row.select_one(".aff-genre-new") or row.select_one(".typeGenre")
        if genre_el:
            genre = normalize_space(genre_el.get_text(" ", strip=True))
            if genre.lower() == "null":
                genre = ""

        duration = ""
        genre_line = row.select_one(".genre-film")
        if genre_line:
            txt = normalize_space(genre_line.get_text(" ", strip=True))
            m = re.search(r"(\d{1,2}h\d{2}|\d{1,3}\s*min)", txt, re.I)
            if m:
                duration = normalize_duration(m.group(1))
            if not genre:
                candidate = normalize_space(re.sub(r"(\d{1,2}h\d{2}|\d{1,3}\s*min)", "", txt, flags=re.I))
                if candidate.lower() != 'null':
                    genre = candidate

        poster = ""
        img = row.select_one("img[data-original], img[src]")
        if img:
            poster = absolute(source["url"], img.get("data-original") or img.get("src") or "")

        info_url = ""
        info_link = row.select_one("a.bt--horaire[href]") or row.select_one(".d-h-fiches-lien[href]") or row.select_one(".img-aff a[href]")
        if info_link:
            info_url = absolute(source["url"], info_link.get("href") or "")

        trailer_url = parse_trailer_from_card(row, source["url"])

        movie = movies.setdefault(
            slug_key(title),
            Movie(title=title, genre=genre, duration=duration, poster=poster, info_url=info_url, trailer_url=trailer_url, shows=[]),
        )
        movie.genre = first_text(movie.genre, genre)
        movie.duration = first_text(movie.duration, duration)
        movie.poster = first_text(movie.poster, poster)
        movie.info_url = first_text(movie.info_url, info_url)
        movie.trailer_url = first_text(movie.trailer_url, trailer_url)

        div_horaire = row.select_one('.div-horaire')
        if not div_horaire:
            continue

        for version_node in div_horaire.select('.version-seance'):
            version = normalize_space(
                version_node.select_one('.b-seance').get_text(' ', strip=True)
                if version_node.select_one('.b-seance') else version_node.get_text(' ', strip=True)
            )
            version = parse_version(version) or version
            line_block = version_node.find_next_sibling(lambda tag: isinstance(tag, Tag) and 'ligne_ach1' in (tag.get('class') or []))
            if line_block is None:
                continue
            grid_row = line_block.select_one('.row.pad-zero') or line_block.select_one('.row')
            if not grid_row:
                continue
            day_cells = grid_row.find_all(class_=re.compile(r'\bheure-seance\b'), recursive=False)
            if len(day_cells) < 7:
                day_cells = grid_row.find_all(class_=re.compile(r'\bheure-seance\b'))[:7]
            for day_index, cell in enumerate(day_cells[:7]):
                show_date = days[day_index]
                for a in cell.find_all('a', href=BOOKING_RE):
                    time = parse_time(a.get_text(' ', strip=True))
                    if not time:
                        continue
                    booking = absolute(source['url'], a.get('href', ''))
                    movie.shows.append(Show(date=show_date, time=time, version=version, cinema=source['name'], booking_url=booking))

    out = []
    for movie in movies.values():
        dedup = {}
        for s in movie.shows:
            dedup[(s.date.isoformat(), s.time, s.cinema, s.booking_url)] = s
        movie.shows = sorted(dedup.values(), key=lambda s: (s.date, s.time, s.cinema))
        if movie.shows:
            out.append(movie)
    return out


def extract_week_header_data(header_text: str, today: dt.date) -> Optional[Tuple[dt.date, dt.date]]:
    txt = normalize_space(header_text)
    m = re.search(r"Semaine du\s*(\d{1,2})[\-/](\d{1,2})\s*au\s*(\d{1,2})[\-/](\d{1,2})", txt, re.I)
    if m:
        d1, m1, d2, m2 = map(int, m.groups())
        y1 = infer_year_for_month(m1, today)
        y2 = infer_year_for_month(m2, today)
        try:
            return dt.date(y1, m1, d1), dt.date(y2, m2, d2)
        except Exception:
            return None
    return None


def parse_trianon_html(html: str, today: dt.date) -> List[Movie]:
    soup = BeautifulSoup(html, 'html.parser')
    movies: Dict[str, Movie] = {}

    for slide in soup.select('#carouselGrille .carousel-item'):
        h3 = slide.find('h3')
        if not h3:
            continue
        week_data = extract_week_header_data(h3.get_text(' ', strip=True), today)
        if not week_data:
            continue
        start, _ = week_data
        current_year = start.year
        table = slide.find('table')
        if not table:
            continue
        rows = table.find_all('tr')
        if len(rows) < 2:
            continue
        header_cells = rows[0].find_all(['th', 'td'])
        column_dates: List[Optional[dt.date]] = [None]
        for cell in header_cells[1:]:
            txt = normalize_space(cell.get_text(' ', strip=True))
            d = parse_french_date(txt, today=today, default_year=current_year)
            column_dates.append(d)
        for row in rows[1:]:
            cells = row.find_all(['td', 'th'])
            if len(cells) < 2:
                continue
            first = cells[0]
            title_link = first.find('a', href=True)
            if not title_link:
                continue
            title = normalize_space(title_link.get_text(' ', strip=True))
            key = slug_key(title)
            movie = movies.setdefault(key, Movie(title=title, info_url=absolute(TRIANON_SOURCE['url'], title_link.get('href', ''))))
            duration_el = first.find(class_=re.compile('infos-techniques'))
            if duration_el and not movie.duration:
                movie.duration = normalize_space(duration_el.get_text(' ', strip=True))
            for idx, cell in enumerate(cells[1:], start=1):
                show_date = column_dates[idx] if idx < len(column_dates) else None
                if not show_date:
                    continue
                for node in cell.find_all(['a', 'span'], recursive=False):
                    txt = normalize_space(node.get_text(' ', strip=True))
                    time = parse_time(txt)
                    if not time:
                        continue
                    booking = absolute(TRIANON_SOURCE['url'], node.get('href', '')) if getattr(node, 'name', '') == 'a' else ''
                    movie.shows.append(Show(date=show_date, time=time, version=parse_version(txt), cinema=TRIANON_SOURCE['name'], booking_url=booking))

    for card in soup.select('#grid .fichefilm'):
        title_link = card.select_one('h2 a[href]')
        if not title_link:
            continue
        title = normalize_space(title_link.get_text(' ', strip=True))
        key = slug_key(title)
        movie = movies.setdefault(key, Movie(title=title, info_url=absolute(TRIANON_SOURCE['url'], title_link.get('href', ''))))
        if not movie.poster:
            img = card.find('img', src=True)
            if img:
                movie.poster = absolute(TRIANON_SOURCE['url'], img.get('src', ''))
        if not movie.duration:
            bold = card.find(class_=re.compile('estandar-bold'))
            if bold:
                text = normalize_space(bold.get_text(' • ', strip=True))
                m = re.search(r"\b(\d{1,2}h\d{2}|\d{1,3}\s*min)\b", text, re.I)
                if m:
                    movie.duration = normalize_duration(m.group(1))
        existing = {(s.date.isoformat(), s.time, s.booking_url) for s in movie.shows}
        for tr in card.select('#seances table tr'):
            txt = normalize_space(tr.get_text(' ', strip=True))
            d = parse_french_date(txt, today)
            t = parse_time(txt)
            if not d or not t:
                continue
            a = tr.find('a', href=True)
            booking = absolute(TRIANON_SOURCE['url'], a.get('href', '')) if a else ''
            key_show = (d.isoformat(), t, booking)
            if key_show in existing:
                continue
            existing.add(key_show)
            movie.shows.append(Show(date=d, time=t, version=parse_version(txt), cinema=TRIANON_SOURCE['name'], booking_url=booking))

    out = []
    for movie in movies.values():
        dedup = {}
        for s in movie.shows:
            dedup[(s.date.isoformat(), s.time, s.cinema, s.booking_url)] = s
        movie.shows = sorted(dedup.values(), key=lambda s: (s.date, s.time, s.cinema))
        if movie.shows:
            out.append(movie)
    return out


def merge_movies(movie_lists: Iterable[List[Movie]]) -> List[Movie]:
    merged: Dict[str, Movie] = {}
    for movies in movie_lists:
        for movie in movies:
            key = slug_key(movie.title)
            if not key:
                continue
            target = merged.get(key)
            if not target:
                merged[key] = Movie(
                    title=movie.title,
                    genre=movie.genre,
                    duration=movie.duration,
                    poster=movie.poster,
                    info_url=movie.info_url,
                    trailer_url=movie.trailer_url,
                    shows=list(movie.shows),
                )
                continue
            target.genre = first_text(target.genre, movie.genre)
            target.duration = first_text(target.duration, movie.duration)
            target.poster = first_text(target.poster, movie.poster)
            target.info_url = first_text(target.info_url, movie.info_url)
            target.trailer_url = first_text(target.trailer_url, movie.trailer_url)
            existing = {(s.date.isoformat(), s.time, s.cinema, s.booking_url) for s in target.shows}
            for show in movie.shows:
                key_show = (show.date.isoformat(), show.time, show.cinema, show.booking_url)
                if key_show not in existing:
                    existing.add(key_show)
                    target.shows.append(show)
    for movie in merged.values():
        movie.shows.sort(key=lambda s: (s.date, s.time, s.cinema))
    return list(merged.values())


def build_week_payload(movies: List[Movie], start: dt.date) -> Dict:
    end = start + dt.timedelta(days=6)
    movie_payloads = []
    for movie in movies:
        shows_in_week = [s for s in movie.shows if start <= s.date <= end]
        if not shows_in_week:
            continue
        day_map = {k: [] for k in DAY_KEYS}
        for show in shows_in_week:
            idx = (show.date - start).days
            if 0 <= idx < 7:
                day_map[DAY_KEYS[idx]].append({
                    'time': show.time,
                    'version': show.version,
                    'cinema': show.cinema,
                    'bookingUrl': show.booking_url,
                })
        if any(day_map.values()):
            movie_payloads.append({
                'title': movie.title,
                'genre': movie.genre,
                'duration': movie.duration,
                'poster': movie.poster,
                'infoUrl': movie.info_url,
                'trailerUrl': movie.trailer_url,
                'days': day_map,
            })
    movie_payloads.sort(key=lambda m: slug_key(m['title']))
    return {'id': start.isoformat(), 'week': {'label': week_label(start), 'days': week_days(start)}, 'movies': movie_payloads}


def filter_to_target_weeks(movies: List[Movie], today: dt.date) -> Tuple[dt.date, dt.date, List[Movie]]:
    current_start = date_to_week_start(today)
    next_start = current_start + dt.timedelta(days=7)
    allowed = {current_start, next_start}
    for movie in movies:
        movie.shows = [s for s in movie.shows if date_to_week_start(s.date) in allowed]
    movies = [m for m in movies if m.shows]
    return current_start, next_start, movies


def load_seed_movies(seed_path: Optional[Path], today: dt.date) -> List[Movie]:
    if not seed_path or not seed_path.exists():
        return []
    try:
        data = json.loads(seed_path.read_text(encoding='utf-8'))
    except Exception:
        return []
    out: List[Movie] = []
    for wk in data.get('weeks') or []:
        for m in wk.get('movies', []):
            movie = Movie(
                title=m.get('title', ''),
                genre=m.get('genre', ''),
                duration=m.get('duration', ''),
                poster=m.get('poster', ''),
                info_url=m.get('infoUrl', ''),
                trailer_url=m.get('trailerUrl', ''),
                shows=[],
            )
            for day in wk.get('week', {}).get('days', []):
                key = day.get('key')
                date_txt = day.get('date')
                if not key or not date_txt:
                    continue
                try:
                    d = dt.date.fromisoformat(date_txt)
                except Exception:
                    continue
                for item in (m.get('days') or {}).get(key, []):
                    movie.shows.append(Show(
                        date=d,
                        time=item.get('time', ''),
                        version=item.get('version', ''),
                        cinema=item.get('cinema', ''),
                        booking_url=item.get('bookingUrl', ''),
                    ))
            if movie.shows:
                out.append(movie)
    _, _, out = filter_to_target_weeks(out, today)
    return out


def fetch_erakys_week_fragment(sess: requests.Session, source: Dict[str, str], dprog: dt.date, id_ms: str = "") -> str:
    ajax_url = urljoin(source['url'], '/FR/ajax/cine/faisan.horaires.journalier')
    params = {'idMS': id_ms, 'dprog': dprog.isoformat()}
    return fetch_text(sess, ajax_url, params=params, ajax=True)


def collect_erakys_movies_for_two_weeks(
    sess: requests.Session,
    source: Dict[str, str],
    today: dt.date,
    seed_html: Optional[str] = None,
) -> List[Movie]:
    base_html = seed_html if seed_html is not None else fetch_text(sess, source['url'])
    base_soup = BeautifulSoup(base_html, 'html.parser')
    available_starts = parse_available_week_starts_from_erakys(base_soup, today)
    selected_start = parse_selected_week_start_from_erakys(base_soup, today)
    id_ms = get_erakys_idms(base_soup)

    current_start = date_to_week_start(today)
    next_start = current_start + dt.timedelta(days=7)
    wanted = [current_start, next_start]
    target_starts = [d for d in wanted if d in available_starts] or ([selected_start] if selected_start else [])

    chunks: List[List[Movie]] = []
    parsed_starts = set()

    if selected_start in target_starts or not target_starts:
        chunks.append(parse_erakys_listing_html(base_html, source, today))
        if selected_start:
            parsed_starts.add(selected_start)

    for week_start in target_starts:
        if week_start in parsed_starts:
            continue
        try:
            fragment_html = fetch_erakys_week_fragment(sess, source, week_start, id_ms=id_ms)
        except Exception as exc:
            print(f"[warn] failed ajax week {source['name']} {week_start}: {exc}", file=sys.stderr)
            continue
        chunks.append(parse_erakys_listing_html(fragment_html, source, today))
        parsed_starts.add(week_start)

    if not chunks:
        chunks.append(parse_erakys_listing_html(base_html, source, today))

    return merge_movies(chunks)


def main() -> int:
    parser = argparse.ArgumentParser(description='Build unified latest.json with current + next Wednesday-to-Tuesday weeks (V3 with Erakys AJAX weeks)')
    parser.add_argument('--output', default='data/latest.json')
    parser.add_argument('--today', default=None)
    parser.add_argument('--seed', default='data/latest.json')
    parser.add_argument('--trianon-html', default=None)
    parser.add_argument('--pantin-html', default=None)
    parser.add_argument('--bobigny-html', default=None)
    parser.add_argument('--montreuil-html', default=None)
    parser.add_argument('--bondy-html', default=None)
    parser.add_argument('--bagnolet-html', default=None)
    args = parser.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    sess = session()

    all_movie_lists: List[List[Movie]] = []
    seed_movies = load_seed_movies(Path(args.seed) if args.seed else None, today)
    if seed_movies:
        all_movie_lists.append(seed_movies)

    overrides = {
        'pantin': args.pantin_html,
        'bobigny': args.bobigny_html,
        'montreuil': args.montreuil_html,
        'bondy': args.bondy_html,
        'bagnolet': args.bagnolet_html,
        'trianon': args.trianon_html,
    }

    for source in ERAKYS_SOURCES:
        seed_html = None
        if overrides.get(source['slug']):
            seed_html = Path(overrides[source['slug']]).read_text(encoding='utf-8', errors='replace')
        try:
            movies = collect_erakys_movies_for_two_weeks(sess, source, today, seed_html=seed_html)
        except Exception as exc:
            print(f"[warn] failed source {source['name']}: {exc}", file=sys.stderr)
            continue
        print(f"[info] {source['name']}: {len(movies)} film(s) with parsed séances", file=sys.stderr)
        all_movie_lists.append(movies)

    trianon_html = None
    if overrides.get('trianon'):
        trianon_html = Path(overrides['trianon']).read_text(encoding='utf-8', errors='replace')
    else:
        try:
            trianon_html = fetch_text(sess, TRIANON_SOURCE['url'])
        except Exception as exc:
            print(f"[warn] failed source Romainville: {exc}", file=sys.stderr)
    if trianon_html:
        trianon_movies = parse_trianon_html(trianon_html, today)
        print(f"[info] Romainville: {len(trianon_movies)} film(s) with parsed séances", file=sys.stderr)
        all_movie_lists.append(trianon_movies)

    merged = merge_movies(all_movie_lists)
    current_start, next_start, merged = filter_to_target_weeks(merged, today)
    current_week = build_week_payload(merged, current_start)
    next_week = build_week_payload(merged, next_start)
    payload = {
        'generatedAt': dt.datetime.now().isoformat(timespec='seconds'),
        'week': current_week['week'],
        'movies': current_week['movies'],
        'weeks': [current_week, next_week],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Wrote {out_path}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
