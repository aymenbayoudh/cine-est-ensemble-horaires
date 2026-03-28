
#!/usr/bin/env python3
"""Build a unified latest.json for Est Ensemble cinemas.

Goals:
- keep exactly 2 week buckets at any given time: current week (Wednesday -> Tuesday)
  and next week
- normalize all cinemas to the same week boundaries even if a source publishes a
  longer date span
- support Trianon weekly carousel parsing directly from /films HTML
- support the 5 Est Ensemble official cinema sites via a generic detail-page parser
  that fetches official listing pages and then each film detail page

The script is intentionally defensive: selectors can vary a bit between cinemas,
so multiple heuristics are tried for links, metadata and showtime extraction.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup, Tag
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "This script needs requests and beautifulsoup4 installed in the GitHub Action environment"
    ) from exc

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)

DAY_KEYS = ["wed", "thu", "fri", "sat", "sun", "mon", "tue"]
DAY_LABELS = {
    "wed": "MER.",
    "thu": "JEU.",
    "fri": "VEN.",
    "sat": "SAM.",
    "sun": "DIM.",
    "mon": "LUN.",
    "tue": "MAR.",
}
WEEKDAY_FR = {
    "lundi": 0,
    "lun": 0,
    "lun.": 0,
    "mardi": 1,
    "mar": 1,
    "mar.": 1,
    "mercredi": 2,
    "mer": 2,
    "mer.": 2,
    "jeudi": 3,
    "jeu": 3,
    "jeu.": 3,
    "vendredi": 4,
    "ven": 4,
    "ven.": 4,
    "samedi": 5,
    "sam": 5,
    "sam.": 5,
    "dimanche": 6,
    "dim": 6,
    "dim.": 6,
}
MONTHS_FR = {
    "janvier": 1,
    "janv": 1,
    "jan": 1,
    "février": 2,
    "fevrier": 2,
    "fév": 2,
    "fév.": 2,
    "mars": 3,
    "avril": 4,
    "avr": 4,
    "avr.": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "juil": 7,
    "juil.": 7,
    "août": 8,
    "aout": 8,
    "aoû": 8,
    "septembre": 9,
    "sept": 9,
    "sep": 9,
    "octobre": 10,
    "oct": 10,
    "novembre": 11,
    "nov": 11,
    "décembre": 12,
    "decembre": 12,
    "déc": 12,
    "dec": 12,
}
VERSION_RE = re.compile(
    r"\b(VF(?:STF|ST-SME| OCAP)?|VO(?:ST ?FR|STF| OCAP)?|VOST ?FR|VF OCAP|VO OCAP|MU)\b",
    re.I,
)
TIME_RE = re.compile(r"\b(\d{1,2})\s*[Hh:]\s*(\d{2})\b")
DATE_DDMMYYYY_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
DATE_DD_MONTH_RE = re.compile(
    r"\b(\d{1,2})\s+([A-Za-zÀ-ÿ\.]+)(?:\s+(\d{4}))?\b", re.I
)
WEEK_HEADER_RE = re.compile(
    r"Semaine\s+du\s*(\d{1,2})\s+au\s*(\d{1,2})\s+([A-Za-zÀ-ÿ]+)", re.I
)
BOOKING_RE = re.compile(r"cine\.boutique/media/\d+\?showId=\d+", re.I)

ERAKYS_SOURCES = [
    {"name": "Pantin", "url": "https://cine104.fr/FR/43/horaires-cinema-cine-104-pantin.html"},
    {"name": "Bobigny", "url": "https://cine-aliceguy.fr/FR/43/horaires-cinema-alice-guy-bobigny.html"},
    {"name": "Montreuil", "url": "https://meliesmontreuil.fr/FR/43/horaires-cinema-le-melies-montreuil.html"},
    {"name": "Bondy", "url": "https://cinemalraux.fr/FR/43/horaires-cinema-andre-malraux-bondy.html"},
    {"name": "Bagnolet", "url": "https://cinhoche.fr/FR/43/horaires-cinema-cinhoche-bagnolet.html"},
]
TRIANON_SOURCE = {"name": "Romainville", "url": "https://www.cinematrianon.fr/films"}


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


# ---------- utility ----------

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
    hh, mm = int(m.group(1)), int(m.group(2))
    return f"{hh:02d}h{mm:02d}"


def parse_version(text: str) -> str:
    m = VERSION_RE.search(text or "")
    if not m:
        return ""
    return normalize_space(m.group(1).upper().replace("  ", " "))


def date_to_week_start(d: dt.date) -> dt.date:
    # Python weekday: Mon=0 ... Sun=6. We want Wed start.
    offset = (d.weekday() - 2) % 7
    return d - dt.timedelta(days=offset)


def week_days(start: dt.date) -> List[Dict[str, str]]:
    return [
        {
            "key": key,
            "label": f"{DAY_LABELS[key]} {((start + dt.timedelta(days=i)).day):02d}",
            "date": (start + dt.timedelta(days=i)).isoformat(),
        }
        for i, key in enumerate(DAY_KEYS)
    ]


def week_label(start: dt.date) -> str:
    end = start + dt.timedelta(days=6)
    return f"Semaine du {start.strftime('%d/%m')} au {end.strftime('%d/%m')}"


def infer_year_for_month(month: int, today: dt.date) -> int:
    # small helper around year changes, good enough for published cinema windows
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

    # e.g. "samedi 4 avril", "4 avril 2026"
    m = DATE_DD_MONTH_RE.search(text)
    if m:
        day = int(m.group(1))
        month_txt = m.group(2).strip(". ").lower()
        year = int(m.group(3)) if m.group(3) else (default_year or infer_year_for_month(MONTHS_FR.get(month_txt, today.month), today))
        month = MONTHS_FR.get(month_txt)
        if month:
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
    s.headers.update({"User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"})
    return s


# ---------- parsing helpers ----------

def unique_detail_links_from_listing(html: str, base_url: str) -> List[str]:
    soup = BeautifulSoup(html, "html.parser")
    urls = []
    seen = set()
    patterns = (
        re.compile(r"/FR/fiche-film-cinema/", re.I),
        re.compile(r"/films/item/", re.I),
        re.compile(r"/evenements/item/", re.I),
    )
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        if not any(p.search(href) for p in patterns):
            continue
        full = absolute(base_url, href)
        full = full.split("#", 1)[0]
        if full in seen:
            continue
        seen.add(full)
        urls.append(full)
    return urls


def parse_meta_movie(soup: BeautifulSoup, page_url: str, fallback_title: str = "") -> Movie:
    title = fallback_title
    og_title = soup.find("meta", attrs={"property": "og:title"})
    if og_title and og_title.get("content"):
        title = og_title["content"].split(" - ")[0]
    if not title:
        h1 = soup.find(["h1", "h2"], string=True)
        if h1:
            title = h1.get_text(" ", strip=True)
    title = normalize_space(re.sub(r"\s*[-–|].*$", "", title))

    poster = ""
    og_img = soup.find("meta", attrs={"property": "og:image"})
    if og_img and og_img.get("content"):
        poster = absolute(page_url, og_img["content"])
    if not poster:
        for img in soup.find_all("img", src=True):
            src = img.get("src", "")
            alt = normalize_space(img.get("alt", "")).lower()
            if "affiche" in src.lower() or "affiche" in alt or "poster" in alt:
                poster = absolute(page_url, src)
                break

    page_text = normalize_space(soup.get_text(" ", strip=True))
    duration = ""
    dur_match = re.search(r"(?:Durée\s*:?\s*|•\s*)(\d{1,2}h\d{2}|\d{2}h\d{2}|\d+h\d{2}|\d+min)", page_text, re.I)
    if dur_match:
        raw = dur_match.group(1).lower().replace(" ", "")
        if raw.endswith("min"):
            raw = raw.replace("min", "")
            duration = f"{int(raw)//60:02d}h{int(raw)%60:02d}"
        else:
            hhmm = parse_time(raw)
            duration = hhmm or raw

    genre = ""
    # try a strong line under the title
    header_block = ""
    for h in soup.find_all(["h1", "h2"]):
        parent = h.parent
        if parent:
            header_block = normalize_space(parent.get_text(" • ", strip=True))
            if header_block:
                break
    if header_block:
        pieces = [p.strip() for p in re.split(r"[•|]", header_block) if p.strip()]
        bad = {title.lower(), duration.lower(), "vf", "vo", "vost fr", "ad", "tout public"}
        for piece in pieces:
            lower = piece.lower()
            if lower in bad or re.search(r"\b\d{4}\b", piece):
                continue
            if re.search(r"avec\b|de\b", lower):
                continue
            genre = piece
            break

    trailer = ""
    for selector in [
        "meta[property='og:video']",
        "iframe[src*='youtube']",
        "iframe[src*='allocine']",
        "source[src$='.mp4']",
        "a[href*='youtube']",
        "a[href*='allocine']",
        "a[href$='.mp4']",
    ]:
        node = soup.select_one(selector)
        if node:
            trailer = absolute(page_url, node.get("content") or node.get("src") or node.get("href"))
            if trailer:
                break

    return Movie(
        title=title,
        genre=genre,
        duration=duration,
        poster=poster,
        info_url=page_url,
        trailer_url=trailer,
        shows=[],
    )


def extract_context_text(anchor: Tag) -> List[str]:
    contexts = []
    seen = set()
    node: Optional[Tag] = anchor
    for _ in range(5):
        if not node:
            break
        if isinstance(node, Tag):
            text = normalize_space(node.get_text(" ", strip=True))
            if text and text not in seen:
                contexts.append(text)
                seen.add(text)
            node = node.parent if isinstance(node.parent, Tag) else None
        else:
            break
    return contexts


def parse_show_from_anchor(anchor: Tag, cinema: str, today: dt.date, default_year: Optional[int] = None) -> Optional[Show]:
    href = absolute(anchor.base_url or "", anchor.get("href", "")) if getattr(anchor, "base_url", None) else anchor.get("href", "")
    href = href or ""
    if not BOOKING_RE.search(href):
        return None

    ctxs = extract_context_text(anchor)
    if not ctxs:
        return None

    # choose first context containing a date + time or enough signal
    best = ctxs[0]
    for candidate in ctxs:
        if parse_time(candidate) and parse_french_date(candidate, today, default_year):
            best = candidate
            break

    show_date = parse_french_date(best, today, default_year)
    show_time = parse_time(best)
    if not show_date or not show_time:
        # last chance: combine multiple contexts
        merged = " | ".join(ctxs)
        show_date = show_date or parse_french_date(merged, today, default_year)
        show_time = show_time or parse_time(merged)
        best = merged
    if not show_date or not show_time:
        return None

    return Show(
        date=show_date,
        time=show_time,
        version=parse_version(best),
        cinema=cinema,
        booking_url=href,
    )


def parse_generic_detail_page(html: str, page_url: str, cinema: str, today: dt.date) -> Movie:
    soup = BeautifulSoup(html, "html.parser")
    movie = parse_meta_movie(soup, page_url)

    # bind base_url on booking anchors for absolute conversion
    for a in soup.find_all("a", href=True):
        a.base_url = page_url  # type: ignore[attr-defined]

    shows: List[Show] = []
    seen = set()
    anchors = soup.find_all("a", href=re.compile(r"cine\.boutique/media/", re.I))
    for a in anchors:
        show = parse_show_from_anchor(a, cinema=cinema, today=today)
        if not show:
            continue
        key = (show.date.isoformat(), show.time, show.booking_url)
        if key in seen:
            continue
        seen.add(key)
        shows.append(show)

    movie.shows = sorted(shows, key=lambda s: (s.date, s.time, s.cinema))
    return movie


# ---------- Trianon specific ----------

def extract_week_header_data(header_text: str, today: dt.date) -> Optional[Tuple[dt.date, dt.date]]:
    txt = normalize_space(header_text)
    m = WEEK_HEADER_RE.search(txt)
    if not m:
        return None
    d1, d2 = int(m.group(1)), int(m.group(2))
    month = MONTHS_FR.get(m.group(3).lower())
    if not month:
        return None
    year = infer_year_for_month(month, today)
    try:
        start = dt.date(year, month, d1)
        end = dt.date(year, month, d2)
    except ValueError:
        return None
    return start, end


def parse_trianon_from_weekly_view(html: str, today: dt.date) -> List[Movie]:
    soup = BeautifulSoup(html, "html.parser")
    movies: Dict[str, Movie] = {}

    for slide in soup.select("#carouselGrille .carousel-item"):
        h3 = slide.find("h3")
        if not h3:
            continue
        week_data = extract_week_header_data(h3.get_text(" ", strip=True), today)
        if not week_data:
            continue
        start, _ = week_data
        current_year = start.year

        table = slide.find("table")
        if not table:
            continue
        rows = table.find_all("tr")
        if len(rows) < 2:
            continue

        header_cells = rows[0].find_all(["th", "td"])
        column_dates: List[Optional[dt.date]] = [None]
        for cell in header_cells[1:]:
            date_txt = normalize_space(cell.get_text(" ", strip=True))
            d = parse_french_date(date_txt, today=today, default_year=current_year)
            column_dates.append(d)

        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            first = cells[0]
            title_link = first.find("a", href=True)
            if not title_link:
                continue
            title = normalize_space(title_link.get_text(" ", strip=True))
            info_url = absolute(TRIANON_SOURCE["url"], title_link.get("href", ""))
            duration_el = first.find(class_=re.compile("infos-techniques"))
            duration = normalize_space(duration_el.get_text(" ", strip=True)) if duration_el else ""
            poster = ""
            for img in slide.find_all("img", alt=True, src=True):
                if title in normalize_space(img.get("alt", "")):
                    poster = absolute(TRIANON_SOURCE["url"], img.get("src", ""))
                    break
            key = slug_key(title)
            movie = movies.setdefault(
                key,
                Movie(title=title, duration=duration, poster=poster, info_url=info_url, shows=[]),
            )
            if duration and not movie.duration:
                movie.duration = duration
            if poster and not movie.poster:
                movie.poster = poster
            if info_url and not movie.info_url:
                movie.info_url = info_url

            for idx, cell in enumerate(cells[1:], start=1):
                show_date = column_dates[idx] if idx < len(column_dates) else None
                if not show_date:
                    continue
                for node in cell.find_all(["a", "span"], recursive=False):
                    text = normalize_space(node.get_text(" ", strip=True))
                    time = parse_time(text)
                    if not time:
                        continue
                    booking = ""
                    if getattr(node, "name", "") == "a":
                        booking = absolute(TRIANON_SOURCE["url"], node.get("href", ""))
                    version = parse_version(text)
                    movie.shows.append(
                        Show(
                            date=show_date,
                            time=time,
                            version=version,
                            cinema=TRIANON_SOURCE["name"],
                            booking_url=booking,
                        )
                    )
    return list(movies.values())


def enrich_trianon_with_grid_view(html: str, movies: List[Movie], today: dt.date) -> List[Movie]:
    soup = BeautifulSoup(html, "html.parser")
    by_key = {slug_key(m.title): m for m in movies}

    for card in soup.select("#grid .fichefilm"):
        title_link = card.select_one("h2 a[href]")
        if not title_link:
            continue
        title = normalize_space(title_link.get_text(" ", strip=True))
        key = slug_key(title)
        movie = by_key.get(key)
        if not movie:
            movie = Movie(title=title, info_url=absolute(TRIANON_SOURCE["url"], title_link.get("href", "")))
            by_key[key] = movie

        # poster
        if not movie.poster:
            img = card.find("img", src=True)
            if img:
                movie.poster = absolute(TRIANON_SOURCE["url"], img.get("src", ""))

        # metadata line
        bold = card.find(class_=re.compile("estandar-bold"))
        if bold:
            text = normalize_space(bold.get_text(" • ", strip=True))
            dur = re.search(r"\b(\d{1,2}h\d{2}|\d{2} min|\d+ min)\b", text, re.I)
            if dur and not movie.duration:
                raw = dur.group(1).replace(" ", "")
                if raw.lower().endswith("min"):
                    mins = int(re.sub(r"\D", "", raw))
                    movie.duration = f"{mins//60:02d}h{mins%60:02d}"
                else:
                    movie.duration = parse_time(raw) or raw
            if not movie.genre:
                pieces = [p.strip() for p in text.split("•") if p.strip()]
                if pieces:
                    # genre often first piece for Trianon grid blocks
                    candidate = pieces[0]
                    if not re.search(r"^de\b|^avec\b|\d{4}", candidate, re.I):
                        movie.genre = candidate

        # trailer
        if not movie.trailer_url:
            source = card.find("source", src=True)
            if source:
                movie.trailer_url = absolute(TRIANON_SOURCE["url"], source.get("src", ""))

        # sessions table
        existing = {(s.date.isoformat(), s.time, s.booking_url) for s in movie.shows}
        for row in card.select("#seances table tr"):
            txt = normalize_space(row.get_text(" ", strip=True))
            show_date = parse_french_date(txt, today)
            show_time = parse_time(txt)
            if not show_date or not show_time:
                continue
            a = row.find("a", href=True)
            booking = absolute(TRIANON_SOURCE["url"], a.get("href", "")) if a else ""
            key_show = (show_date.isoformat(), show_time, booking)
            if key_show in existing:
                continue
            existing.add(key_show)
            movie.shows.append(
                Show(
                    date=show_date,
                    time=show_time,
                    version=parse_version(txt),
                    cinema=TRIANON_SOURCE["name"],
                    booking_url=booking,
                )
            )

    return list(by_key.values())


def parse_trianon_html(html: str, today: dt.date) -> List[Movie]:
    weekly = parse_trianon_from_weekly_view(html, today)
    return enrich_trianon_with_grid_view(html, weekly, today)


# ---------- aggregation ----------

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
            if idx < 0 or idx >= 7:
                continue
            day_map[DAY_KEYS[idx]].append(
                {
                    "time": show.time,
                    "version": show.version,
                    "cinema": show.cinema,
                    "bookingUrl": show.booking_url,
                }
            )
        if not any(day_map.values()):
            continue
        movie_payloads.append(
            {
                "title": movie.title,
                "genre": movie.genre,
                "duration": movie.duration,
                "poster": movie.poster,
                "infoUrl": movie.info_url,
                "trailerUrl": movie.trailer_url,
                "days": day_map,
            }
        )

    movie_payloads.sort(key=lambda m: slug_key(m["title"]))
    return {
        "id": start.isoformat(),
        "week": {
            "label": week_label(start),
            "days": week_days(start),
        },
        "movies": movie_payloads,
    }


def filter_to_target_weeks(movies: List[Movie], today: dt.date) -> Tuple[dt.date, dt.date, List[Movie]]:
    current_start = date_to_week_start(today)
    next_start = current_start + dt.timedelta(days=7)
    allowed_starts = {current_start, next_start}

    for movie in movies:
        movie.shows = [s for s in movie.shows if date_to_week_start(s.date) in allowed_starts]
    movies = [m for m in movies if m.shows]
    return current_start, next_start, movies


# ---------- source fetchers ----------

def fetch_text(sess: requests.Session, url: str, timeout: int = 25) -> str:
    resp = sess.get(url, timeout=timeout)
    resp.raise_for_status()
    resp.encoding = resp.encoding or "utf-8"
    return resp.text


def parse_erakys_source(sess: requests.Session, source: Dict[str, str], today: dt.date) -> List[Movie]:
    listing_html = fetch_text(sess, source["url"])
    detail_links = unique_detail_links_from_listing(listing_html, source["url"])
    movies: List[Movie] = []
    for detail_url in detail_links:
        try:
            html = fetch_text(sess, detail_url)
            movie = parse_generic_detail_page(html, detail_url, cinema=source["name"], today=today)
            if movie.title and movie.shows:
                movies.append(movie)
        except Exception as exc:
            print(f"[warn] failed detail {detail_url}: {exc}", file=sys.stderr)
    return movies


def parse_trianon_source(sess: requests.Session, today: dt.date, html_override: Optional[str] = None) -> List[Movie]:
    html = html_override if html_override is not None else fetch_text(sess, TRIANON_SOURCE["url"])
    return parse_trianon_html(html, today)


def load_seed_movies(seed_path: Optional[Path], today: dt.date) -> List[Movie]:
    if not seed_path or not seed_path.exists():
        return []
    try:
        data = json.loads(seed_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    weeks = data.get("weeks") or []
    out: List[Movie] = []
    for wk in weeks:
        for m in wk.get("movies", []):
            movie = Movie(
                title=m.get("title", ""),
                genre=m.get("genre", ""),
                duration=m.get("duration", ""),
                poster=m.get("poster", ""),
                info_url=m.get("infoUrl", ""),
                trailer_url=m.get("trailerUrl", ""),
                shows=[],
            )
            for day in wk.get("week", {}).get("days", []):
                key = day.get("key")
                date_txt = day.get("date")
                if not key or not date_txt:
                    continue
                try:
                    day_date = dt.date.fromisoformat(date_txt)
                except ValueError:
                    continue
                for item in (m.get("days", {}) or {}).get(key, []):
                    movie.shows.append(
                        Show(
                            date=day_date,
                            time=item.get("time", ""),
                            version=item.get("version", ""),
                            cinema=item.get("cinema", ""),
                            booking_url=item.get("bookingUrl", ""),
                        )
                    )
            if movie.shows:
                out.append(movie)
    current_start, next_start, out = filter_to_target_weeks(out, today)
    return out


# ---------- main ----------

def main() -> int:
    parser = argparse.ArgumentParser(description="Build unified latest.json with current + next Wednesday-to-Tuesday weeks")
    parser.add_argument("--output", default="data/latest.json")
    parser.add_argument("--today", default=None, help="Override today ISO date for testing, e.g. 2026-03-27")
    parser.add_argument("--trianon-html", default=None, help="Optional local HTML file for Trianon /films page")
    parser.add_argument("--seed", default="data/latest.json", help="Optional existing latest.json used as fallback metadata/backup")
    args = parser.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    sess = session()

    trianon_html = None
    if args.trianon_html:
        trianon_html = Path(args.trianon_html).read_text(encoding="utf-8", errors="replace")

    all_movie_lists: List[List[Movie]] = []

    # seed first (fallback only, official data may overwrite/extend)
    seed_movies = load_seed_movies(Path(args.seed) if args.seed else None, today)
    if seed_movies:
        all_movie_lists.append(seed_movies)

    # official Est Ensemble cinemas
    for source in ERAKYS_SOURCES:
        try:
            movies = parse_erakys_source(sess, source, today)
            print(f"[info] {source['name']}: {len(movies)} film(s) with parsed séances", file=sys.stderr)
            all_movie_lists.append(movies)
        except Exception as exc:
            print(f"[warn] failed source {source['name']}: {exc}", file=sys.stderr)

    # Trianon
    try:
        trianon_movies = parse_trianon_source(sess, today, html_override=trianon_html)
        print(f"[info] Romainville: {len(trianon_movies)} film(s) with parsed séances", file=sys.stderr)
        all_movie_lists.append(trianon_movies)
    except Exception as exc:
        print(f"[warn] failed source Romainville: {exc}", file=sys.stderr)

    merged = merge_movies(all_movie_lists)
    current_start, next_start, merged = filter_to_target_weeks(merged, today)

    current_week = build_week_payload(merged, current_start)
    next_week = build_week_payload(merged, next_start)

    payload = {
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "week": current_week["week"],
        "movies": current_week["movies"],
        "weeks": [current_week, next_week],
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
