async function loadData() {
  const response = await fetch('./data/latest.json');
  if (!response.ok) throw new Error('Impossible de charger data/latest.json');
  return response.json();
}

const CINEMA_PRIORITY = { montreuil: 0, pantin: 1, romainville: 2, bagnolet: 3, bobigny: 4, bondy: 5 };
const CINEMA_LABELS = { montreuil: 'Montreuil', pantin: 'Pantin', romainville: 'Romainville', bagnolet: 'Bagnolet', bobigny: 'Bobigny', bondy: 'Bondy' };
const CINEMA_LINKS = {
  montreuil: 'https://meliesmontreuil.fr/FR/43/horaires-cinema-le-melies-montreuil.html',
  pantin: 'https://cine104.fr/FR/43/horaires-cinema-cine-104-pantin.html',
  romainville: 'https://www.cinematrianon.fr/films',
  bagnolet: 'https://cinhoche.fr/FR/43/horaires-cinema-cinhoche-bagnolet.html',
  bobigny: 'https://cine-aliceguy.fr/FR/43/horaires-cinema-alice-guy-bobigny.html',
  bondy: 'https://cinemalraux.fr/FR/43/horaires-cinema-andre-malraux-bondy.html',
};
const FILTER_CINEMA_KEYS = ['montreuil', 'pantin', 'romainville', 'bagnolet', 'bobigny', 'bondy'];
const TIME_STEP_MINUTES = 5;
const HISTOGRAM_BIN_MINUTES = 30;

const state = {
  data: null,
  selectedWeekId: null,
  view: 'line',
  filters: { cinemas: [], dates: [] },
  timeFilter: { min: null, max: null },
  searchQuery: '',
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeData(data) {
  if (data && Array.isArray(data.weeks) && data.weeks.length) return data.weeks;
  if (data && data.week && Array.isArray(data.movies)) {
    const firstDate = data.week.days && data.week.days[0] ? data.week.days[0].date : null;
    return [{ id: firstDate || data.week.label || 'week-1', week: data.week, movies: data.movies }];
  }
  return [];
}

function getCinemaClass(cinema) {
  const normalized = String(cinema || '').toLowerCase();
  if (normalized.includes('pantin')) return 'pantin';
  if (normalized.includes('romainville') || normalized.includes('trianon')) return 'romainville';
  if (normalized.includes('bagnolet')) return 'bagnolet';
  if (normalized.includes('montreuil')) return 'montreuil';
  if (normalized.includes('bondy')) return 'bondy';
  if (normalized.includes('bobigny')) return 'bobigny';
  return 'default';
}

function getCurrentWeeks() { return normalizeData(state.data || {}); }
function getSelectedWeek() {
  const weeks = getCurrentWeeks();
  return weeks.find((entry) => (entry.id || entry.week?.label) === state.selectedWeekId) || weeks[0] || null;
}

function getLocalDateFromIso(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getTodayDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getTodayIndex(daysConfig) {
  const today = getTodayDate();
  return (daysConfig || []).findIndex((day) => {
    const target = getLocalDateFromIso(day.date);
    return !!target && target.getTime() === today.getTime();
  });
}

function getVisibleDays(daysConfig) {
  const todayIndex = getTodayIndex(daysConfig || []);
  return todayIndex >= 0 ? (daysConfig || []).slice(todayIndex) : (daysConfig || []);
}

function titleCaseDayAbbrev(label) {
  const base = String(label || '').trim().toLowerCase();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

function formatDisplayDate(day) {
  if (!day || !day.date) return day?.label || '';
  const date = getLocalDateFromIso(day.date);
  if (!date) return day.label || '';
  const today = getTodayDate();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.getTime() === today.getTime()) return "Aujourd'hui";
  if (date.getTime() === tomorrow.getTime()) return 'Demain';
  const dayLabel = titleCaseDayAbbrev((day.label || '').split(' ')[0]);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dayLabel} ${dd}/${mm}`;
}

function getDateFilterLabel(day) { return formatDisplayDate(day); }
function getRelativeDayLabel(day) { return formatDisplayDate(day); }

function formatWeekRangeLabel(week) {
  const days = week?.days || [];
  if (days.length < 7) return week?.label || '';
  const first = days[0];
  const last = days[6];
  const firstDate = getLocalDateFromIso(first.date);
  const lastDate = getLocalDateFromIso(last.date);
  if (!firstDate || !lastDate) return week?.label || '';
  const f = titleCaseDayAbbrev((first.label || '').split(' ')[0]);
  const l = titleCaseDayAbbrev((last.label || '').split(' ')[0]);
  const fdd = String(firstDate.getDate()).padStart(2, '0');
  const fmm = String(firstDate.getMonth() + 1).padStart(2, '0');
  const ldd = String(lastDate.getDate()).padStart(2, '0');
  const lmm = String(lastDate.getMonth() + 1).padStart(2, '0');
  return `Semaine du ${f} ${fdd}/${fmm} au ${l} ${ldd}/${lmm}`;
}

function timeToMinutes(timeStr) {
  const match = /^(\d{1,2})h(\d{2})$/.exec(String(timeStr || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function minutesToTimeValue(totalMinutes) {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function minutesToDisplayLabel(totalMinutes) {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}`;
}

function timeValueToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function roundDownToStep(value, step) { return Math.floor(value / step) * step; }
function roundUpToStep(value, step) { return Math.ceil(value / step) * step; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function getMovieDayItems(movie, key) { return movie?.days?.[key] || []; }

function getBestLeadDayPriority(movie, week) {
  const visibleDays = getVisibleDays(week?.days || []);
  const leadDay = visibleDays[0];
  if (!leadDay) return { hasLeadDay: false, cinemaRank: 999, timeRank: 9999 };
  const leadShows = getMovieDayItems(movie, leadDay.key);
  if (!leadShows.length) return { hasLeadDay: false, cinemaRank: 999, timeRank: 9999 };
  let cinemaRank = 999;
  let timeRank = 9999;
  for (const show of leadShows) {
    const cinemaClass = getCinemaClass(show.cinema);
    cinemaRank = Math.min(cinemaRank, CINEMA_PRIORITY[cinemaClass] ?? 999);
    const minutes = timeToMinutes(show.time);
    if (minutes != null) timeRank = Math.min(timeRank, minutes);
  }
  return { hasLeadDay: true, cinemaRank, timeRank };
}

function hasVisibleShow(movie, week) {
  return getVisibleDays(week?.days || []).some((day) => getMovieDayItems(movie, day.key).length > 0);
}

function getBaseFilteredDayItems(movie, week) {
  const selectedCinemas = state.filters.cinemas;
  const selectedDates = state.filters.dates;
  const visibleDays = getVisibleDays(week?.days || []);
  const daysToInspect = selectedDates.length ? visibleDays.filter((day) => selectedDates.includes(day.key)) : visibleDays;
  const result = [];
  for (const day of daysToInspect) {
    const items = getMovieDayItems(movie, day.key);
    if (!items.length) continue;
    const cinemaFiltered = selectedCinemas.length ? items.filter((item) => selectedCinemas.includes(getCinemaClass(item.cinema))) : items.slice();
    if (cinemaFiltered.length) result.push({ day, items: cinemaFiltered });
  }
  return result;
}

function movieMatchesFilters(movie, week) {
  return getBaseFilteredDayItems(movie, week).length > 0;
}

function getTimeDomainForWeek(week) {
  const movies = week?.movies || [];
  const minuteValues = [];
  for (const movie of movies) {
    const dayGroups = getBaseFilteredDayItems(movie, week?.week || week || {});
    for (const group of dayGroups) {
      for (const item of group.items) {
        const minutes = timeToMinutes(item.time);
        if (minutes != null) minuteValues.push(minutes);
      }
    }
  }
  if (!minuteValues.length) return { min: 8 * 60, max: 23 * 60, bins: [] };
  const min = roundDownToStep(Math.min(...minuteValues), HISTOGRAM_BIN_MINUTES);
  const max = roundUpToStep(Math.max(...minuteValues), HISTOGRAM_BIN_MINUTES);
  const bins = [];
  for (let start = min; start <= max; start += HISTOGRAM_BIN_MINUTES) {
    const end = start + HISTOGRAM_BIN_MINUTES;
    const count = minuteValues.filter((value) => value >= start && value < end).length;
    bins.push({ start, end, count });
  }
  return { min, max, bins };
}

function getEffectiveTimeFilter(weekEntry) {
  const domain = getTimeDomainForWeek(weekEntry);
  const currentMin = state.timeFilter.min == null ? domain.min : clamp(state.timeFilter.min, domain.min, domain.max);
  const currentMax = state.timeFilter.max == null ? domain.max : clamp(state.timeFilter.max, domain.min, domain.max);
  const min = Math.min(currentMin, currentMax);
  const max = Math.max(currentMin, currentMax);
  return { ...domain, selectedMin: min, selectedMax: max };
}

function movieHasTimeInRange(movie, weekEntry, timeFilter) {
  const groups = getBaseFilteredDayItems(movie, weekEntry?.week || weekEntry || {});
  for (const group of groups) {
    if (group.items.some((item) => {
      const minutes = timeToMinutes(item.time);
      return minutes != null && minutes >= timeFilter.selectedMin && minutes <= timeFilter.selectedMax;
    })) {
      return true;
    }
  }
  return false;
}

function sortMoviesForWeek(movies, weekEntry) {
  const week = weekEntry?.week || weekEntry || {};
  const timeFilter = getEffectiveTimeFilter(weekEntry);
  const query = (state.searchQuery || '').trim().toLowerCase();
  return (movies || []).slice()
    .filter((movie) => hasVisibleShow(movie, week))
    .filter((movie) => movieMatchesFilters(movie, week))
    .filter((movie) => movieHasTimeInRange(movie, weekEntry, timeFilter))
    .sort((a, b) => {
      const aMatch = query && String(a?.title || '').toLowerCase().includes(query);
      const bMatch = query && String(b?.title || '').toLowerCase().includes(query);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      const aPriority = getBestLeadDayPriority(a, week);
      const bPriority = getBestLeadDayPriority(b, week);
      if (aPriority.hasLeadDay !== bPriority.hasLeadDay) return aPriority.hasLeadDay ? -1 : 1;
      if (aPriority.hasLeadDay && bPriority.hasLeadDay) {
        if (aPriority.cinemaRank !== bPriority.cinemaRank) return aPriority.cinemaRank - bPriority.cinemaRank;
        if (aPriority.timeRank !== bPriority.timeRank) return aPriority.timeRank - bPriority.timeRank;
      }
      return String(a?.title || '').localeCompare(String(b?.title || ''), 'fr', { sensitivity: 'base' });
    });
}

function renderShowContent(item, mode) {
  const timeClass = mode === 'grid' ? 'grid-show-time' : 'schedule-time';
  const subClass = mode === 'grid' ? 'grid-show-sub' : 'schedule-sub';
  const version = item.version ? ` · ${escapeHtml(item.version)}` : '';
  return `<span class="${timeClass}">${escapeHtml(item.time)}</span><span class="${subClass}">${escapeHtml(item.cinema)}${version}</span>`;
}

function renderWeekSwitcher(weeks, selectedId) {
  if (!weeks.length) return '';
  const options = weeks.map((entry) => {
    const value = entry.id || entry.week?.label || '';
    const selected = value === selectedId ? ' selected' : '';
    const label = formatWeekRangeLabel(entry.week) || entry.week?.label || value;
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  return `<div class="week-switcher"><select id="week-select" class="week-select" aria-label="Choisir une semaine">${options}</select></div>`;
}

function renderFilterToggleChip(label, classes, type, value, isActive) {
  const stateClass = isActive ? 'is-active' : 'is-inactive';
  const pressed = isActive ? 'true' : 'false';
  return `<button type="button" class="filter-chip filter-chip-toggle ${classes} ${stateClass}" data-filter-type="${type}" data-filter-value="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;
}

function renderFilterControls(week) {
  const visibleDays = getVisibleDays(week?.days || []);
  const cinemaChips = FILTER_CINEMA_KEYS.map((cinemaKey) => renderFilterToggleChip(
    CINEMA_LABELS[cinemaKey] || cinemaKey,
    `filter-chip--cinema filter-chip--${cinemaKey}`,
    'cinema',
    cinemaKey,
    state.filters.cinemas.includes(cinemaKey)
  )).join('');

  const dateChips = visibleDays.map((day) => renderFilterToggleChip(
    getDateFilterLabel(day),
    'filter-chip--date',
    'date',
    day.key,
    state.filters.dates.includes(day.key)
  )).join('');

  return `${cinemaChips}${dateChips}<button id="filter-reset-inline-btn" class="filter-reset-inline-btn" type="button">Réinitialiser</button>`;
}

function renderHistogramBars(timeFilter) {
  const maxCount = Math.max(1, ...timeFilter.bins.map((bin) => bin.count));
  return timeFilter.bins.map((bin) => {
    const height = Math.max(8, Math.round((bin.count / maxCount) * 64));
    const inRange = bin.end > timeFilter.selectedMin && bin.start < timeFilter.selectedMax;
    const cls = inRange ? 'is-in-range' : 'is-out-range';
    return `<div class="time-filter-bar ${cls}" style="height:${height}px" title="${escapeHtml(minutesToDisplayLabel(bin.start))}–${escapeHtml(minutesToDisplayLabel(bin.end))} : ${bin.count}"></div>`;
  }).join('');
}

function renderTimeFilter(weekEntry) {
  const timeFilter = getEffectiveTimeFilter(weekEntry);
  const selectedWidth = Math.max(0, timeFilter.selectedMax - timeFilter.selectedMin);
  const totalWidth = Math.max(1, timeFilter.max - timeFilter.min);
  const startPct = ((timeFilter.selectedMin - timeFilter.min) / totalWidth) * 100;
  const widthPct = (selectedWidth / totalWidth) * 100;
  return `
    <div class="time-filter" id="time-filter" aria-label="Filtrer par heure de début">
      <div class="time-filter-head">
        <div class="time-filter-title">Heure de début</div>
        <div class="time-filter-range-label">${escapeHtml(minutesToDisplayLabel(timeFilter.selectedMin))} – ${escapeHtml(minutesToDisplayLabel(timeFilter.selectedMax))}</div>
      </div>
      <div class="time-filter-inputs">
        <label class="time-filter-label">Min
          <input id="time-min-input" class="time-filter-time-input" type="time" step="300" value="${escapeHtml(minutesToTimeValue(timeFilter.selectedMin))}">
        </label>
        <label class="time-filter-label">Max
          <input id="time-max-input" class="time-filter-time-input" type="time" step="300" value="${escapeHtml(minutesToTimeValue(timeFilter.selectedMax))}">
        </label>
      </div>
      <div class="time-filter-chart-wrap">
        <div class="time-filter-bars">${renderHistogramBars(timeFilter)}</div>
        <div class="time-filter-track">
          <div class="time-filter-active-track" style="left:${startPct}%; width:${widthPct}%"></div>
        </div>
        <div class="time-filter-sliders">
          <input id="time-min-range" class="time-filter-range time-filter-range--min" type="range" min="${timeFilter.min}" max="${timeFilter.max}" step="${TIME_STEP_MINUTES}" value="${timeFilter.selectedMin}" aria-label="Heure minimale">
          <input id="time-max-range" class="time-filter-range time-filter-range--max" type="range" min="${timeFilter.min}" max="${timeFilter.max}" step="${TIME_STEP_MINUTES}" value="${timeFilter.selectedMax}" aria-label="Heure maximale">
        </div>
      </div>
      <div class="time-filter-axis">
        <span>${escapeHtml(minutesToDisplayLabel(timeFilter.min))}</span>
        <span>${escapeHtml(minutesToDisplayLabel(timeFilter.max))}</span>
      </div>
    </div>
  `;
}

function renderTopControls(weeks, selectedId, weekEntry) {
  return `
    <div class="top-controls">
      <div class="controls-row controls-row--primary">
        ${renderWeekSwitcher(weeks, selectedId)}
        ${renderTimeFilter(weekEntry)}
      </div>
      <div class="filter-bar">
        <div class="filter-summary" id="filter-summary">${renderFilterControls(weekEntry?.week || weekEntry || {})}</div>
      </div>
    </div>
  `;
}

function renderInfoModal() {
  const items = FILTER_CINEMA_KEYS.map((key) => `<li><strong>${escapeHtml(CINEMA_LABELS[key])}</strong> : <a href="${escapeHtml(CINEMA_LINKS[key])}" target="_blank" rel="noopener noreferrer">${escapeHtml(CINEMA_LINKS[key])}</a></li>`).join('');
  return `<div id="info-modal" class="info-modal" aria-hidden="true"><div class="filter-modal__backdrop" data-info-close="true"></div><div class="filter-modal__panel info-modal__panel" role="dialog" aria-modal="true" aria-labelledby="info-title"><div class="filter-modal__header"><h2 id="info-title" class="filter-modal__title">Liens vers sites des cinémas</h2><button id="info-close-btn" class="filter-modal__close" type="button" aria-label="Fermer">×</button></div><div class="info-modal__content"><ul class="info-links-list">${items}</ul></div></div></div>`;
}

function renderSchedule(daysConfig, movieDays) {
  const visibleDays = getVisibleDays(daysConfig || []);
  const ths = visibleDays.map((day) => `<th>${escapeHtml(day.label)}</th>`).join('');
  const tds = visibleDays.map((day) => {
    const items = movieDays?.[day.key] || [];
    if (!items.length) return '<td><span class="empty">-</span></td>';
    const html = items.map((item) => {
      const cinemaClass = getCinemaClass(item.cinema);
      const href = item.bookingUrl || '#';
      const target = item.bookingUrl ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="schedule-item schedule-item--${cinemaClass}" href="${escapeHtml(href)}"${target}>${renderShowContent(item, 'schedule')}</a>`;
    }).join('');
    return `<td>${html}</td>`;
  }).join('');
  return `<div class="schedule-wrap"><table class="schedule"><tr>${ths}</tr><tr>${tds}</tr></table></div>`;
}

function renderGridDayBlocks(daysConfig, movieDays) {
  const visibleDays = getVisibleDays(daysConfig || []);
  return visibleDays.map((day) => {
    const items = movieDays?.[day.key] || [];
    const label = getRelativeDayLabel(day);
    if (!items.length) return `<div class="grid-day-block"><div class="grid-day-title">${escapeHtml(label)}</div><div class="empty">Aucune séance</div></div>`;
    const shows = items.map((item) => {
      const cinemaClass = getCinemaClass(item.cinema);
      const href = item.bookingUrl || '#';
      const target = item.bookingUrl ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="grid-show grid-show--${cinemaClass}" href="${escapeHtml(href)}"${target}>${renderShowContent(item, 'grid')}</a>`;
    }).join('');
    return `<div class="grid-day-block"><div class="grid-day-title">${escapeHtml(label)}</div>${shows}</div>`;
  }).join('');
}

function renderInfoButton(url, extraClass = 'btn') {
  return url ? `<a class="${extraClass}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Infos et bande-annonce</a>` : '';
}

function renderPoster(url, title, className = '') {
  return url ? `<img class="${className}" src="${escapeHtml(url)}" alt="Affiche ${escapeHtml(title)}">` : '';
}

function renderListMovie(movie, week, index) {
  return `<article class="movie-list-card" data-movie-index="${index}"><div class="poster-wrap">${movie.infoUrl ? `<a href="${escapeHtml(movie.infoUrl)}" target="_blank" rel="noopener noreferrer">${renderPoster(movie.poster, movie.title)}</a>` : renderPoster(movie.poster, movie.title)}</div><div class="movie-content"><h3 class="movie-title">${escapeHtml(movie.title)}</h3><div class="movie-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div><div class="movie-links">${renderInfoButton(movie.infoUrl)}</div>${renderSchedule(week.days || [], movie.days || {})}</div></article>`;
}

function renderGridMovie(movie, week, index) {
  return `<article class="movie-grid-card" data-movie-index="${index}">${renderPoster(movie.poster, movie.title, 'movie-grid-poster')}<div class="movie-grid-overlay"><div class="movie-grid-title">${escapeHtml(movie.title)}</div><div class="movie-grid-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div><div class="movie-grid-actions">${renderInfoButton(movie.infoUrl, 'grid-btn')}</div><div class="grid-scroll">${renderGridDayBlocks(week.days || [], movie.days || {})}</div></div></article>`;
}

function renderMovies(movies, weekEntry) {
  const visibleMovies = sortMoviesForWeek(movies || [], weekEntry);
  if (!visibleMovies.length) return '<div class="empty">Aucun film ne correspond aux filtres sélectionnés.</div>';
  const week = weekEntry?.week || weekEntry || {};
  return visibleMovies.map((movie, index) => `${renderListMovie(movie, week, index)}${renderGridMovie(movie, week, index)}`).join('');
}

function setView(view) {
  state.view = view;
  const container = document.getElementById('movies-container');
  const btnLine = document.getElementById('view-line');
  const btnGrid = document.getElementById('view-grid');
  if (!container || !btnLine || !btnGrid) return;
  container.classList.toggle('view-line', view === 'line');
  container.classList.toggle('view-grid', view === 'grid');
  btnLine.classList.toggle('is-active', view === 'line');
  btnGrid.classList.toggle('is-active', view === 'grid');
}

function setupViewSwitch() {
  const btnLine = document.getElementById('view-line');
  const btnGrid = document.getElementById('view-grid');
  if (!btnLine || !btnGrid) return;
  btnLine.onclick = () => setView('line');
  btnGrid.onclick = () => setView('grid');
  setView(state.view);
}

function setupGridCardTouchBehavior() {
  document.querySelectorAll('.movie-grid-card').forEach((card) => {
    card.onclick = (event) => {
      if (event.target.closest('a')) return;
      card.classList.toggle('open');
    };
  });
}

function openInfoModal() {
  const modal = document.getElementById('info-modal');
  if (modal) {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closeInfoModal() {
  const modal = document.getElementById('info-modal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

function toggleFilterValue(type, value) {
  if (type === 'cinema') {
    const exists = state.filters.cinemas.includes(value);
    state.filters.cinemas = exists ? state.filters.cinemas.filter((item) => item !== value) : [...state.filters.cinemas, value];
  }
  if (type === 'date') {
    const exists = state.filters.dates.includes(value);
    state.filters.dates = exists ? state.filters.dates.filter((item) => item !== value) : [...state.filters.dates, value];
  }
  renderApp();
}

function resetFilters() {
  state.filters = { cinemas: [], dates: [] };
  renderApp();
}

function setTimeFilter(minValue, maxValue) {
  const weekEntry = getSelectedWeek();
  const domain = getEffectiveTimeFilter(weekEntry);
  let nextMin = clamp(roundDownToStep(minValue, TIME_STEP_MINUTES), domain.min, domain.max);
  let nextMax = clamp(roundUpToStep(maxValue, TIME_STEP_MINUTES), domain.min, domain.max);
  if (nextMin > nextMax) {
    const swap = nextMin;
    nextMin = nextMax;
    nextMax = swap;
  }
  state.timeFilter = { min: nextMin, max: nextMax };
  renderApp();
}

function resetTimeFilterToDomain() {
  const weekEntry = getSelectedWeek();
  const domain = getTimeDomainForWeek(weekEntry);
  state.timeFilter = { min: domain.min, max: domain.max };
}

function performPageSearch() {
  const input = document.getElementById('page-search-input');
  const status = document.getElementById('page-search-status');
  if (!input || !status) return;
  state.searchQuery = input.value.trim();
  status.textContent = '';
  input.classList.remove('is-error');
  if (!state.searchQuery) { renderApp(); return; }
  const selectedWeek = getSelectedWeek();
  const visibleMovies = sortMoviesForWeek(selectedWeek?.movies || [], selectedWeek);
  const hasMatch = visibleMovies.some((movie) => String(movie?.title || '').toLowerCase().includes(state.searchQuery.toLowerCase()));
  if (!hasMatch) {
    status.textContent = 'Aucun titre correspondant';
    input.classList.add('is-error');
  }
  renderApp();
}

function setupSearchControls() {
  const input = document.getElementById('page-search-input');
  const button = document.getElementById('page-search-btn');
  if (!input || !button) return;
  input.value = state.searchQuery || '';
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      performPageSearch();
    }
  };
  input.oninput = () => {
    const status = document.getElementById('page-search-status');
    if (status) status.textContent = '';
    input.classList.remove('is-error');
    if (!input.value.trim() && state.searchQuery) {
      state.searchQuery = '';
      renderApp();
    }
  };
  button.onclick = performPageSearch;
}

function setupTimeFilterControls() {
  const minRange = document.getElementById('time-min-range');
  const maxRange = document.getElementById('time-max-range');
  const minInput = document.getElementById('time-min-input');
  const maxInput = document.getElementById('time-max-input');
  if (!minRange || !maxRange || !minInput || !maxInput) return;

  minRange.oninput = () => setTimeFilter(Number(minRange.value), Number(maxRange.value));
  maxRange.oninput = () => setTimeFilter(Number(minRange.value), Number(maxRange.value));

  minInput.onchange = () => {
    const minValue = timeValueToMinutes(minInput.value);
    const maxValue = timeValueToMinutes(maxInput.value);
    if (minValue != null && maxValue != null) setTimeFilter(minValue, maxValue);
  };
  maxInput.onchange = () => {
    const minValue = timeValueToMinutes(minInput.value);
    const maxValue = timeValueToMinutes(maxInput.value);
    if (minValue != null && maxValue != null) setTimeFilter(minValue, maxValue);
  };
}

function setupControlEvents() {
  const weekSelect = document.getElementById('week-select');
  const filterResetInlineBtn = document.getElementById('filter-reset-inline-btn');
  const infoOpenBtn = document.getElementById('info-open-btn');
  const infoCloseBtn = document.getElementById('info-close-btn');

  if (weekSelect) {
    weekSelect.onchange = (event) => {
      state.selectedWeekId = event.target.value;
      state.filters = { cinemas: [], dates: [] };
      resetTimeFilterToDomain();
      renderApp();
    };
  }
  if (filterResetInlineBtn) filterResetInlineBtn.onclick = resetFilters;
  if (infoOpenBtn) infoOpenBtn.onclick = openInfoModal;
  if (infoCloseBtn) infoCloseBtn.onclick = closeInfoModal;

  document.querySelectorAll('.filter-chip-toggle').forEach((node) => {
    node.onclick = () => toggleFilterValue(node.dataset.filterType, node.dataset.filterValue);
  });
  document.querySelectorAll('[data-info-close="true"]').forEach((node) => { node.onclick = closeInfoModal; });
  document.onkeydown = (event) => { if (event.key === 'Escape') closeInfoModal(); };

  setupTimeFilterControls();
}

function renderApp() {
  const switcherContainer = document.getElementById('week-switcher-container');
  const moviesContainer = document.getElementById('movies-container');
  const weeks = getCurrentWeeks();
  const selectedWeek = getSelectedWeek();
  if (!selectedWeek) {
    if (switcherContainer) switcherContainer.innerHTML = '';
    if (moviesContainer) moviesContainer.innerHTML = '<div class="empty">Aucune donnée disponible.</div>';
    return;
  }
  if (switcherContainer) switcherContainer.innerHTML = renderTopControls(weeks, selectedWeek.id || selectedWeek.week?.label, selectedWeek);
  if (moviesContainer) moviesContainer.innerHTML = renderMovies(selectedWeek.movies || [], selectedWeek);
  setupViewSwitch();
  setupControlEvents();
  setupSearchControls();
  setupGridCardTouchBehavior();
  setView(state.view);
}

async function main() {
  const moviesContainer = document.getElementById('movies-container');
  const infoModalMount = document.getElementById('info-modal-mount');
  if (infoModalMount) infoModalMount.innerHTML = renderInfoModal();
  try {
    state.data = await loadData();
    const weeks = getCurrentWeeks();
    state.selectedWeekId = weeks[0] ? (weeks[0].id || weeks[0].week?.label) : null;
    resetTimeFilterToDomain();
    renderApp();
  } catch (error) {
    console.error(error);
    if (moviesContainer) moviesContainer.innerHTML = `<div class="empty">Erreur : ${escapeHtml(error.message)}</div>`;
  }
}

main();
