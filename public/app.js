
async function loadData() {
  const response = await fetch('../data/latest.json');
  if (!response.ok) {
    throw new Error('Impossible de charger data/latest.json');
  }
  return response.json();
}

function normalizeData(data) {
  if (Array.isArray(data?.weeks) && data.weeks.length) return data.weeks;
  if (data?.week && Array.isArray(data?.movies)) {
    return [{
      id: data.week?.days?.[0]?.date || data.week?.label || 'week-1',
      week: data.week,
      movies: data.movies,
    }];
  }
  return [];
}

const CINEMA_PRIORITY = {
  montreuil: 0,
  pantin: 1,
  romainville: 2,
  bagnolet: 3,
  bobigny: 4,
  bondy: 5,
};

const CINEMA_LABELS = {
  montreuil: 'Montreuil',
  pantin: 'Pantin',
  romainville: 'Romainville',
  bagnolet: 'Bagnolet',
  bobigny: 'Bobigny',
  bondy: 'Bondy',
};

const state = {
  data: null,
  selectedWeekId: null,
  view: 'line',
  filters: {
    cinemas: [],
    dates: [],
  },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function getCurrentWeeks() {
  return normalizeData(state.data || {});
}

function getSelectedWeek() {
  const weeks = getCurrentWeeks();
  return weeks.find((entry) => (entry.id || entry.week?.label) === state.selectedWeekId) || weeks[0] || null;
}

function getLocalDateFromIso(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getTodayIndex(daysConfig) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return daysConfig.findIndex((day) => {
    const target = getLocalDateFromIso(day.date);
    return target && target.getTime() === today.getTime();
  });
}

function getVisibleDays(daysConfig) {
  const todayIndex = getTodayIndex(daysConfig);
  return todayIndex >= 0 ? daysConfig.slice(todayIndex) : daysConfig;
}

function getRelativeDayLabel(day) {
  if (!day?.date) return day?.label || '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = getLocalDateFromIso(day.date);
  if (!target) return day.label;
  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return 'Demain';
  return day.label;
}

function formatShortDate(dateStr) {
  const [year, month, day] = String(dateStr || '').split('-');
  if (!day || !month) return String(dateStr || '');
  return `${day}/${month}`;
}

function getDateFilterLabel(day, index) {
  if (index === 0) return "Aujourd'hui";
  if (index === 1) return 'Demain';
  return formatShortDate(day.date);
}

function timeToMinutes(timeStr) {
  const match = /^(\d{1,2})h(\d{2})$/.exec(String(timeStr || ''));
  if (!match) return 9999;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getBestTodayPriority(movie, week) {
  const todayIndex = getTodayIndex(week.days || []);
  if (todayIndex < 0) return { hasToday: false, cinemaRank: 999, timeRank: 9999 };

  const todayKey = week.days[todayIndex]?.key;
  const todayShows = movie?.days?.[todayKey] || [];
  if (!todayShows.length) return { hasToday: false, cinemaRank: 999, timeRank: 9999 };

  let cinemaRank = 999;
  let timeRank = 9999;
  for (const show of todayShows) {
    const cinemaClass = getCinemaClass(show.cinema);
    cinemaRank = Math.min(cinemaRank, CINEMA_PRIORITY[cinemaClass] ?? 999);
    timeRank = Math.min(timeRank, timeToMinutes(show.time));
  }
  return { hasToday: true, cinemaRank, timeRank };
}

function hasVisibleShow(movie, week) {
  const visibleDays = getVisibleDays(week.days || []);
  return visibleDays.some((day) => (movie?.days?.[day.key] || []).length > 0);
}

function movieMatchesFilters(movie, week) {
  const selectedCinemas = state.filters.cinemas;
  const selectedDates = state.filters.dates;
  const visibleDays = getVisibleDays(week.days || []);
  const daysToInspect = selectedDates.length
    ? visibleDays.filter((day) => selectedDates.includes(day.key))
    : visibleDays;

  if (!daysToInspect.length) return false;

  return daysToInspect.some((day) => {
    const items = movie?.days?.[day.key] || [];
    if (!items.length) return false;
    if (!selectedCinemas.length) return true;
    return items.some((item) => selectedCinemas.includes(getCinemaClass(item.cinema)));
  });
}

function sortMoviesForWeek(movies, week) {
  return [...movies]
    .filter((movie) => hasVisibleShow(movie, week))
    .filter((movie) => movieMatchesFilters(movie, week))
    .sort((a, b) => {
      const aPriority = getBestTodayPriority(a, week);
      const bPriority = getBestTodayPriority(b, week);

      if (aPriority.hasToday !== bPriority.hasToday) return aPriority.hasToday ? -1 : 1;
      if (aPriority.hasToday && bPriority.hasToday) {
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
  return `
    <span class="${timeClass}">${escapeHtml(item.time)}</span>
    <span class="${subClass}">${escapeHtml(item.cinema)}${version}</span>
  `;
}

function renderWeekSwitcher(weeks, selectedId) {
  if (!weeks.length) return '';
  const options = weeks.map((entry) => {
    const value = entry.id || entry.week?.label || '';
    const selected = value === selectedId ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(entry.week?.label || value)}</option>`;
  }).join('');

  return `
    <div class="week-switcher">
      <select id="week-select" class="week-select" aria-label="Choisir une semaine">
        ${options}
      </select>
    </div>
  `;
}

function getFilterSummary() {
  const cinemaCount = state.filters.cinemas.length;
  const dateCount = state.filters.dates.length;
  if (!cinemaCount && !dateCount) return 'Aucun filtre';
  const parts = [];
  if (cinemaCount) parts.push(`${cinemaCount} cinéma${cinemaCount > 1 ? 's' : ''}`);
  if (dateCount) parts.push(`${dateCount} date${dateCount > 1 ? 's' : ''}`);
  return parts.join(' • ');
}

function renderTopControls(weeks, selectedId) {
  return `
    <div class="top-controls">
      ${renderWeekSwitcher(weeks, selectedId)}
      <div class="filter-bar">
        <button id="filter-open-btn" class="filter-open-btn" type="button">Filtrer</button>
        <span class="filter-summary">${escapeHtml(getFilterSummary())}</span>
      </div>
    </div>
  `;
}

function renderCinemaOption(cinemaKey) {
  const checked = state.filters.cinemas.includes(cinemaKey) ? ' checked' : '';
  return `
    <label class="filter-option filter-option--${cinemaKey}">
      <input class="filter-cinema-input" type="checkbox" value="${cinemaKey}"${checked}>
      <span class="filter-box"></span>
      <span class="filter-option-text">${escapeHtml(CINEMA_LABELS[cinemaKey])}</span>
    </label>
  `;
}

function renderDateOption(day, index) {
  const checked = state.filters.dates.includes(day.key) ? ' checked' : '';
  return `
    <label class="filter-option filter-option--date">
      <input class="filter-date-input" type="checkbox" value="${escapeHtml(day.key)}"${checked}>
      <span class="filter-box"></span>
      <span class="filter-option-text">${escapeHtml(getDateFilterLabel(day, index))}</span>
    </label>
  `;
}

function renderFilterModal(week) {
  if (!week) return '';
  const visibleDays = getVisibleDays(week.days || []);
  const cinemaOptions = ['montreuil', 'pantin', 'romainville', 'bagnolet', 'bobigny', 'bondy']
    .map(renderCinemaOption)
    .join('');
  const dateOptions = visibleDays.map((day, index) => renderDateOption(day, index)).join('');

  return `
    <div id="filter-modal" class="filter-modal" aria-hidden="true">
      <div class="filter-modal__backdrop" data-filter-close="true"></div>
      <div class="filter-modal__panel" role="dialog" aria-modal="true" aria-labelledby="filter-title">
        <div class="filter-modal__header">
          <h2 id="filter-title" class="filter-modal__title">Filtrer</h2>
          <button id="filter-close-btn" class="filter-modal__close" type="button" aria-label="Fermer">×</button>
        </div>

        <div class="filter-modal__section">
          <div class="filter-modal__subtitle">Cinémas</div>
          <div class="filter-options-row">${cinemaOptions}</div>
        </div>

        <div class="filter-modal__section">
          <div class="filter-modal__subtitle">Dates</div>
          <div class="filter-options-row">${dateOptions}</div>
        </div>

        <div class="filter-modal__actions">
          <button id="filter-reset-btn" class="filter-reset-btn" type="button">Réinitialiser</button>
          <button id="filter-apply-btn" class="filter-apply-btn" type="button">Valider</button>
        </div>
      </div>
    </div>
  `;
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
      return `
        <a class="schedule-item schedule-item--${cinemaClass}" href="${escapeHtml(href)}"${target}>
          ${renderShowContent(item, 'schedule')}
        </a>
      `;
    }).join('');
    return `<td>${html}</td>`;
  }).join('');

  return `
    <div class="schedule-wrap">
      <table class="schedule">
        <tr>${ths}</tr>
        <tr>${tds}</tr>
      </table>
    </div>
  `;
}

function renderGridDayBlocks(daysConfig, movieDays) {
  const visibleDays = getVisibleDays(daysConfig || []);
  return visibleDays.map((day) => {
    const items = movieDays?.[day.key] || [];
    const label = getRelativeDayLabel(day);
    if (!items.length) {
      return `
        <div class="grid-day-block">
          <div class="grid-day-title">${escapeHtml(label)}</div>
          <div class="empty">Aucune séance</div>
        </div>
      `;
    }

    const shows = items.map((item) => {
      const cinemaClass = getCinemaClass(item.cinema);
      const href = item.bookingUrl || '#';
      const target = item.bookingUrl ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `
        <a class="grid-show grid-show--${cinemaClass}" href="${escapeHtml(href)}"${target}>
          ${renderShowContent(item, 'grid')}
        </a>
      `;
    }).join('');

    return `
      <div class="grid-day-block">
        <div class="grid-day-title">${escapeHtml(label)}</div>
        ${shows}
      </div>
    `;
  }).join('');
}

function renderInfoButton(url, extraClass = 'btn') {
  if (!url) return '';
  return `<a class="${extraClass}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Infos et bande-annonce</a>`;
}

function renderPoster(url, title, className = '') {
  if (!url) return '';
  return `<img class="${className}" src="${escapeHtml(url)}" alt="Affiche ${escapeHtml(title)}">`;
}

function renderListMovie(movie, week) {
  return `
    <article class="movie-list-card">
      <div class="poster-wrap">
        ${movie.infoUrl ? `<a href="${escapeHtml(movie.infoUrl)}" target="_blank" rel="noopener noreferrer">${renderPoster(movie.poster, movie.title)}</a>` : renderPoster(movie.poster, movie.title)}
      </div>
      <div class="movie-content">
        <h3 class="movie-title">${escapeHtml(movie.title)}</h3>
        <div class="movie-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div>
        <div class="movie-links">${renderInfoButton(movie.infoUrl)}</div>
        ${renderSchedule(week.days || [], movie.days || {})}
      </div>
    </article>
  `;
}

function renderGridMovie(movie, week) {
  return `
    <article class="movie-grid-card">
      ${renderPoster(movie.poster, movie.title, 'movie-grid-poster')}
      <div class="movie-grid-overlay">
        <div class="movie-grid-title">${escapeHtml(movie.title)}</div>
        <div class="movie-grid-meta">${escapeHtml(movie.genre || '')}${movie.genre && movie.duration ? ' · ' : ''}${escapeHtml(movie.duration || '')}</div>
        <div class="movie-grid-actions">${renderInfoButton(movie.infoUrl, 'grid-btn')}</div>
        <div class="grid-scroll">${renderGridDayBlocks(week.days || [], movie.days || {})}</div>
      </div>
    </article>
  `;
}

function renderMovies(movies, week) {
  const visibleMovies = sortMoviesForWeek(movies || [], week);
  if (!visibleMovies.length) {
    return '<div class="empty">Aucun film ne correspond aux filtres sélectionnés.</div>';
  }
  return visibleMovies.map((movie) => `${renderListMovie(movie, week)}${renderGridMovie(movie, week)}`).join('');
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
      const clickedLink = event.target.closest('a');
      if (clickedLink) return;
      card.classList.toggle('open');
    };
  });
}

function openFilterModal() {
  const modal = document.getElementById('filter-modal');
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeFilterModal() {
  const modal = document.getElementById('filter-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function applyFiltersFromModal() {
  const cinemaInputs = Array.from(document.querySelectorAll('.filter-cinema-input:checked'));
  const dateInputs = Array.from(document.querySelectorAll('.filter-date-input:checked'));
  state.filters = {
    cinemas: cinemaInputs.map((input) => input.value),
    dates: dateInputs.map((input) => input.value),
  };
  closeFilterModal();
  renderApp();
}

function resetFilters() {
  state.filters = { cinemas: [], dates: [] };
  closeFilterModal();
  renderApp();
}

function setupControlEvents() {
  const weekSelect = document.getElementById('week-select');
  const filterOpenBtn = document.getElementById('filter-open-btn');
  const filterCloseBtn = document.getElementById('filter-close-btn');
  const filterApplyBtn = document.getElementById('filter-apply-btn');
  const filterResetBtn = document.getElementById('filter-reset-btn');

  if (weekSelect) {
    weekSelect.onchange = (event) => {
      state.selectedWeekId = event.target.value;
      state.filters = { cinemas: [], dates: [] };
      renderApp();
    };
  }
  if (filterOpenBtn) filterOpenBtn.onclick = openFilterModal;
  if (filterCloseBtn) filterCloseBtn.onclick = closeFilterModal;
  if (filterApplyBtn) filterApplyBtn.onclick = applyFiltersFromModal;
  if (filterResetBtn) filterResetBtn.onclick = resetFilters;

  document.querySelectorAll('[data-filter-close="true"]').forEach((node) => {
    node.onclick = closeFilterModal;
  });

  document.onkeydown = (event) => {
    if (event.key === 'Escape') closeFilterModal();
  };
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

  if (switcherContainer) {
    switcherContainer.innerHTML = `
      ${renderTopControls(weeks, selectedWeek.id || selectedWeek.week?.label)}
      ${renderFilterModal(selectedWeek.week)}
    `;
  }

  if (moviesContainer) {
    moviesContainer.innerHTML = renderMovies(selectedWeek.movies || [], selectedWeek.week || {});
  }

  setupViewSwitch();
  setupControlEvents();
  setupGridCardTouchBehavior();
  setView(state.view);
}

async function main() {
  const moviesContainer = document.getElementById('movies-container');
  try {
    state.data = await loadData();
    const weeks = getCurrentWeeks();
    state.selectedWeekId = weeks[0] ? (weeks[0].id || weeks[0].week?.label) : null;
    renderApp();
  } catch (error) {
    console.error(error);
    if (moviesContainer) {
      moviesContainer.innerHTML = `<div class="empty">Erreur : ${escapeHtml(error.message)}</div>`;
    }
  }
}

main();
