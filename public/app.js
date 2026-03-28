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

const state = {
  data: null,
  selectedWeekId: null,
  view: 'line',
  filters: { cinemas: [], dates: [] },
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
  return match ? Number(match[1]) * 60 + Number(match[2]) : 9999;
}
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
    timeRank = Math.min(timeRank, timeToMinutes(show.time));
  }
  return { hasLeadDay: true, cinemaRank, timeRank };
}

function hasVisibleShow(movie, week) {
  return getVisibleDays(week?.days || []).some((day) => getMovieDayItems(movie, day.key).length > 0);
}
function movieMatchesFilters(movie, week) {
  const selectedCinemas = state.filters.cinemas;
  const selectedDates = state.filters.dates;
  const visibleDays = getVisibleDays(week?.days || []);
  const daysToInspect = selectedDates.length ? visibleDays.filter((day) => selectedDates.includes(day.key)) : visibleDays;
  if (!daysToInspect.length) return false;
  for (const day of daysToInspect) {
    const items = getMovieDayItems(movie, day.key);
    if (!items.length) continue;
    if (!selectedCinemas.length) return true;
    if (items.some((item) => selectedCinemas.includes(getCinemaClass(item.cinema)))) return true;
  }
  return false;
}

function sortMoviesForWeek(movies, week) {
  const query = (state.searchQuery || '').trim().toLowerCase();
  return (movies || []).slice()
    .filter((movie) => hasVisibleShow(movie, week))
    .filter((movie) => movieMatchesFilters(movie, week))
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
function renderFilterChip(label, chipClass) { return `<span class="filter-chip ${chipClass || ''}">${escapeHtml(label)}</span>`; }
function getFilterSummaryHtml(week) {
  const pieces = [];
  for (const cinemaKey of state.filters.cinemas) pieces.push(renderFilterChip(CINEMA_LABELS[cinemaKey] || cinemaKey, `filter-chip--cinema filter-chip--${cinemaKey}`));
  const visibleDays = getVisibleDays(week?.days || []);
  for (const dayKey of state.filters.dates) {
    const day = visibleDays.find((item) => item.key === dayKey) || (week?.days || []).find((item) => item.key === dayKey);
    if (day) pieces.push(renderFilterChip(getDateFilterLabel(day), 'filter-chip--date'));
  }
  if (!pieces.length) return '<span class="filter-summary-empty">Aucun filtre</span>';
  return pieces.join('') + '<button id="filter-reset-inline-btn" class="filter-reset-inline-btn" type="button">Réinitialiser</button>';
}
function renderTopControls(weeks, selectedId, week) {
  return `<div class="top-controls">${renderWeekSwitcher(weeks, selectedId)}<div class="filter-bar"><button id="filter-open-btn" class="filter-open-btn" type="button">Filtrer</button><div class="filter-summary" id="filter-summary">${getFilterSummaryHtml(week)}</div></div></div>`;
}
function renderCinemaOption(cinemaKey) {
  const checked = state.filters.cinemas.includes(cinemaKey) ? ' checked' : '';
  return `<label class="filter-option filter-option--${cinemaKey}"><input class="filter-cinema-input" type="checkbox" value="${cinemaKey}"${checked}><span class="filter-box"></span><span class="filter-option-text">${escapeHtml(CINEMA_LABELS[cinemaKey])}</span></label>`;
}
function renderDateOption(day) {
  const checked = state.filters.dates.includes(day.key) ? ' checked' : '';
  return `<label class="filter-option filter-option--date"><input class="filter-date-input" type="checkbox" value="${escapeHtml(day.key)}"${checked}><span class="filter-box"></span><span class="filter-option-text">${escapeHtml(getDateFilterLabel(day))}</span></label>`;
}
function renderFilterModal(week) {
  if (!week) return '';
  const visibleDays = getVisibleDays(week.days || []);
  const cinemaOptions = ['montreuil','pantin','romainville','bagnolet','bobigny','bondy'].map(renderCinemaOption).join('');
  const dateOptions = visibleDays.map(renderDateOption).join('');
  return `<div id="filter-modal" class="filter-modal" aria-hidden="true"><div class="filter-modal__backdrop" data-filter-close="true"></div><div class="filter-modal__panel" role="dialog" aria-modal="true" aria-labelledby="filter-title"><div class="filter-modal__header"><h2 id="filter-title" class="filter-modal__title">Filtrer</h2><button id="filter-close-btn" class="filter-modal__close" type="button" aria-label="Fermer">×</button></div><div class="filter-modal__section"><div class="filter-modal__subtitle">Cinémas</div><div class="filter-options-row">${cinemaOptions}</div></div><div class="filter-modal__section"><div class="filter-modal__subtitle">Dates</div><div class="filter-options-row">${dateOptions}</div></div><div class="filter-modal__actions"><button id="filter-reset-btn" class="filter-reset-btn" type="button">Réinitialiser</button><button id="filter-apply-btn" class="filter-apply-btn" type="button">Valider</button></div></div></div>`;
}
function renderInfoModal() {
  const items = ['montreuil','pantin','romainville','bagnolet','bobigny','bondy']
    .map((key) => `<li><strong>${escapeHtml(CINEMA_LABELS[key])}</strong> : <a href="${escapeHtml(CINEMA_LINKS[key])}" target="_blank" rel="noopener noreferrer">${escapeHtml(CINEMA_LINKS[key])}</a></li>`).join('');
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
function renderInfoButton(url, extraClass = 'btn') { return url ? `<a class="${extraClass}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Infos et bande-annonce</a>` : ''; }
function renderPoster(url, title, className = '') { return url ? `<img class="${className}" src="${escapeHtml(url)}" alt="Affiche ${escapeHtml(title)}">` : ''; }
function renderListMovie(movie, week, index) {
  return `<article class="movie-list-card" data-movie-index="${index}"><div class="poster-wrap">${movie.infoUrl ? `<a href="${escapeHtml(movie.infoUrl)}" target="_blank" rel="noopener noreferrer">${renderPoster(movie.poster, movie.title)}</a>` : renderPoster(movie.poster, movie.title)}</div><div class="movie-content"><h3 class="movie-title">${escapeHtml(movie.title)}</h3><div class="movie-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div><div class="movie-links">${renderInfoButton(movie.infoUrl)}</div>${renderSchedule(week.days || [], movie.days || {})}</div></article>`;
}
function renderGridMovie(movie, week, index) {
  return `<article class="movie-grid-card" data-movie-index="${index}">${renderPoster(movie.poster, movie.title, 'movie-grid-poster')}<div class="movie-grid-overlay"><div class="movie-grid-title">${escapeHtml(movie.title)}</div><div class="movie-grid-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div><div class="movie-grid-actions">${renderInfoButton(movie.infoUrl, 'grid-btn')}</div><div class="grid-scroll">${renderGridDayBlocks(week.days || [], movie.days || {})}</div></div></article>`;
}
function renderMovies(movies, week) {
  const visibleMovies = sortMoviesForWeek(movies || [], week);
  if (!visibleMovies.length) return '<div class="empty">Aucun film ne correspond aux filtres sélectionnés.</div>';
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
function openFilterModal() { const modal = document.getElementById('filter-modal'); if (modal) { modal.classList.add('is-open'); modal.setAttribute('aria-hidden', 'false'); } }
function closeFilterModal() { const modal = document.getElementById('filter-modal'); if (modal) { modal.classList.remove('is-open'); modal.setAttribute('aria-hidden', 'true'); } }
function openInfoModal() { const modal = document.getElementById('info-modal'); if (modal) { modal.classList.add('is-open'); modal.setAttribute('aria-hidden', 'false'); } }
function closeInfoModal() { const modal = document.getElementById('info-modal'); if (modal) { modal.classList.remove('is-open'); modal.setAttribute('aria-hidden', 'true'); } }
function applyFiltersFromModal() {
  const cinemaInputs = Array.from(document.querySelectorAll('.filter-cinema-input:checked'));
  const dateInputs = Array.from(document.querySelectorAll('.filter-date-input:checked'));
  state.filters = { cinemas: cinemaInputs.map((input) => input.value), dates: dateInputs.map((input) => input.value) };
  closeFilterModal();
  renderApp();
}
function resetFilters() { state.filters = { cinemas: [], dates: [] }; closeFilterModal(); renderApp(); }
function performPageSearch() {
  const input = document.getElementById('page-search-input');
  const status = document.getElementById('page-search-status');
  if (!input || !status) return;
  state.searchQuery = input.value.trim();
  status.textContent = '';
  input.classList.remove('is-error');
  if (!state.searchQuery) { renderApp(); return; }
  const selectedWeek = getSelectedWeek();
  const visibleMovies = sortMoviesForWeek(selectedWeek?.movies || [], selectedWeek?.week || {});
  const hasMatch = visibleMovies.some((movie) => String(movie?.title || '').toLowerCase().includes(state.searchQuery.toLowerCase()));
  if (!hasMatch) { status.textContent = 'Aucun titre correspondant'; input.classList.add('is-error'); }
  renderApp();
}
function setupSearchControls() {
  const input = document.getElementById('page-search-input');
  const button = document.getElementById('page-search-btn');
  if (!input || !button) return;
  input.value = state.searchQuery || '';
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); performPageSearch(); } };
  input.oninput = () => {
    const status = document.getElementById('page-search-status');
    if (status) status.textContent = '';
    input.classList.remove('is-error');
    if (!input.value.trim() && state.searchQuery) { state.searchQuery = ''; renderApp(); }
  };
  button.onclick = performPageSearch;
}
function setupControlEvents() {
  const weekSelect = document.getElementById('week-select');
  const filterOpenBtn = document.getElementById('filter-open-btn');
  const filterCloseBtn = document.getElementById('filter-close-btn');
  const filterApplyBtn = document.getElementById('filter-apply-btn');
  const filterResetBtn = document.getElementById('filter-reset-btn');
  const filterResetInlineBtn = document.getElementById('filter-reset-inline-btn');
  const infoOpenBtn = document.getElementById('info-open-btn');
  const infoCloseBtn = document.getElementById('info-close-btn');
  if (weekSelect) weekSelect.onchange = (event) => { state.selectedWeekId = event.target.value; state.filters = { cinemas: [], dates: [] }; renderApp(); };
  if (filterOpenBtn) filterOpenBtn.onclick = openFilterModal;
  if (filterCloseBtn) filterCloseBtn.onclick = closeFilterModal;
  if (filterApplyBtn) filterApplyBtn.onclick = applyFiltersFromModal;
  if (filterResetBtn) filterResetBtn.onclick = resetFilters;
  if (filterResetInlineBtn) filterResetInlineBtn.onclick = resetFilters;
  if (infoOpenBtn) infoOpenBtn.onclick = openInfoModal;
  if (infoCloseBtn) infoCloseBtn.onclick = closeInfoModal;
  document.querySelectorAll('[data-filter-close="true"]').forEach((node) => { node.onclick = closeFilterModal; });
  document.querySelectorAll('[data-info-close="true"]').forEach((node) => { node.onclick = closeInfoModal; });
  document.onkeydown = (event) => { if (event.key === 'Escape') { closeFilterModal(); closeInfoModal(); } };
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
  if (switcherContainer) switcherContainer.innerHTML = `${renderTopControls(weeks, selectedWeek.id || selectedWeek.week?.label, selectedWeek.week)}${renderFilterModal(selectedWeek.week)}`;
  if (moviesContainer) moviesContainer.innerHTML = renderMovies(selectedWeek.movies || [], selectedWeek.week || {});
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
    renderApp();
  } catch (error) {
    console.error(error);
    if (moviesContainer) moviesContainer.innerHTML = `<div class="empty">Erreur : ${escapeHtml(error.message)}</div>`;
  }
}
main();
