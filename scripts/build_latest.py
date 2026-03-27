from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "samples"
DATA_DIR = ROOT / "data"
OUTPUT_JSON = DATA_DIR / "latest.json"

SAMPLE_SOURCES = [
    {
        "path": SAMPLES_DIR / "bagnolet.html",
        "cinema": "Bagnolet",
        "base_url": "https://cinhoche.fr",
    },
    {
        "path": SAMPLES_DIR / "pantin.html",
        "cinema": "Pantin",
        "base_url": "https://cine104.fr",
    },
    {
        "path": SAMPLES_DIR / "bobigny.html",
        "cinema": "Bobigny",
        "base_url": "https://bobigny...fr",
    },
    {
        "path": SAMPLES_DIR / "montreuil.html",
        "cinema": "Montreuil",
        "base_url": "https://montreuil...fr",
    },
]

FR_DAY_ABBR = ["MER.", "JEU.", "VEN.", "SAM.", "DIM.", "LUN.", "MAR."]
DAY_KEYS = ["wed", "thu", "fri", "sat", "sun", "mon", "tue"]


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace(" ", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def absolute_url(url: str | None, base_url: str) -> str:
    if not url:
        return ""
    return urljoin(base_url, url)


def parse_week(soup: BeautifulSoup) -> dict:
    select = soup.select_one("#selecteurSemaine option[selected], #selecteurSemaine option")
    if not select:
        raise RuntimeError("Impossible de trouver la semaine dans le HTML")

    start_date = datetime.strptime(select.get("value"), "%Y-%m-%d")
    label = clean_text(select.get_text())
    days = []
    for i, (key, abbr) in enumerate(zip(DAY_KEYS, FR_DAY_ABBR)):
        current = start_date + timedelta(days=i)
        days.append(
            {
                "key": key,
                "label": f"{abbr} {current.day:02d}",
                "date": current.strftime("%Y-%m-%d"),
            }
        )
    return {"label": label, "days": days}


def parse_genre_duration(block: BeautifulSoup) -> tuple[str, str]:
    genre_text = clean_text(block.select_one(".genre-film").get_text(" ", strip=True) if block.select_one(".genre-film") else "")
    if "|" in genre_text:
        genre, duration = [clean_text(x) for x in genre_text.split("|", 1)]
        return genre, duration
    match = re.search(r"(.+?)\s+(\d{2}h\d{2})$", genre_text)
    if match:
        return clean_text(match.group(1)), clean_text(match.group(2))
    return genre_text, ""


def parse_movie_block(block: BeautifulSoup, cinema: str, base_url: str) -> dict:
    title = clean_text(block.select_one("h3").get_text(" ", strip=True) if block.select_one("h3") else "")
    if not title:
        raise RuntimeError("Bloc film sans titre")

    poster_anchor = block.select_one(".img-aff a")
    poster_img = block.select_one(".img-aff img")
    info_url = absolute_url(poster_anchor.get("href") if poster_anchor else "", base_url)
    poster = absolute_url((poster_img.get("data-original") or poster_img.get("src")) if poster_img else "", base_url)

    genre, duration = parse_genre_duration(block)

    trailer_node = block.select_one(".H-new .openplayba, .z-mob-h .openplayba")
    trailer_url = absolute_url(trailer_node.get("rel") if trailer_node else "", base_url)

    days = {key: [] for key in DAY_KEYS}

    right_col = block.select_one(".div-horaire .row")
    if right_col is None:
        return {
            "title": title,
            "genre": genre,
            "duration": duration,
            "poster": poster,
            "infoUrl": info_url,
            "trailerUrl": trailer_url,
            "days": days,
        }

    children = [child for child in right_col.find_all(recursive=False) if getattr(child, "name", None)]
    current_version = ""

    for child in children:
        classes = child.get("class", [])
        if "version-seance" in classes:
            current_version = clean_text(child.select_one(".b-seance").get_text(" ", strip=True) if child.select_one(".b-seance") else "")
        elif "ligne_ach1" in classes:
            row = child.select_one(".row.pad-zero")
            if row is None:
                continue
            cells = row.select(".heure-seance")
            for idx, cell in enumerate(cells[:7]):
                for link in cell.select("a[href]"):
                    time_text = clean_text(link.get_text(" ", strip=True))
                    if not time_text or time_text == "-":
                        continue
                    days[DAY_KEYS[idx]].append(
                        {
                            "time": time_text,
                            "version": current_version,
                            "cinema": cinema,
                            "bookingUrl": absolute_url(link.get("href"), base_url),
                        }
                    )

    return {
        "title": title,
        "genre": genre,
        "duration": duration,
        "poster": poster,
        "infoUrl": info_url,
        "trailerUrl": trailer_url,
        "days": days,
    }


def parse_source(path: Path, cinema: str, base_url: str) -> tuple[dict, list[dict]]:
    html = path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    week = parse_week(soup)
    blocks = soup.select("div.row.featurette.esp-fiche-horaire")
    movies = [parse_movie_block(block, cinema=cinema, base_url=base_url) for block in blocks]
    return week, movies


def time_sort_key(item: dict) -> tuple:
    match = re.match(r"(\d{1,2})h(\d{2})", item.get("time", ""))
    if match:
        return int(match.group(1)), int(match.group(2)), item.get("cinema", "")
    return 99, 99, item.get("cinema", "")


def aggregate_movies(all_movies: list[dict]) -> list[dict]:
    by_title: dict[str, dict] = {}

    for movie in all_movies:
        title = movie["title"]
        if title not in by_title:
            by_title[title] = {
                "title": movie["title"],
                "genre": movie.get("genre", ""),
                "duration": movie.get("duration", ""),
                "poster": movie.get("poster", ""),
                "infoUrl": movie.get("infoUrl", ""),
                "trailerUrl": movie.get("trailerUrl", ""),
                "days": {key: [] for key in DAY_KEYS},
            }
        target = by_title[title]
        if not target.get("poster") and movie.get("poster"):
            target["poster"] = movie["poster"]
        if not target.get("infoUrl") and movie.get("infoUrl"):
            target["infoUrl"] = movie["infoUrl"]
        if not target.get("trailerUrl") and movie.get("trailerUrl"):
            target["trailerUrl"] = movie["trailerUrl"]

        for key in DAY_KEYS:
            target["days"][key].extend(movie["days"].get(key, []))

    result = list(by_title.values())
    for movie in result:
        for key in DAY_KEYS:
            movie["days"][key] = sorted(movie["days"][key], key=time_sort_key)
    result.sort(key=lambda m: m["title"])
    return result


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    all_movies = []
    week = None
    for source in SAMPLE_SOURCES:
        if not source["path"].exists():
            print(f"Fichier manquant : {source['path']}")
            continue
        source_week, movies = parse_source(source["path"], source["cinema"], source["base_url"])
        if week is None:
            week = source_week
        all_movies.extend(movies)

    if week is None:
        raise RuntimeError("Aucune source HTML trouvée dans samples/")

    payload = {
        "week": week,
        "movies": aggregate_movies(all_movies),
    }

    OUTPUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK : {OUTPUT_JSON} généré avec {len(payload['movies'])} films")


if __name__ == "__main__":
    main()
