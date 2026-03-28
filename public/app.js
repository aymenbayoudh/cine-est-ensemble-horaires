
async function loadData() {
  const response = await fetch('./data/latest.json');
  if (!response.ok) {
    throw new Error('Impossible de charger data/latest.json');
  }
  return response.json();
}

function normalizeData(data) {
  if (data && Array.isArray(data.weeks) && data.weeks.length) {
    return data.weeks;
  }
  if (data && data.week && Array.isArray(data.movies)) {
    var firstDate = data.week.days && data.week.days[0] ? data.week.days[0].date : null;
    return [{
      id: firstDate || data.week.label || 'week-1',
      week: data.week,
      movies: data.movies
    }];
  }
  return [];
}

var CINEMA_PRIORITY = {
  montreuil: 0,
  pantin: 1,
  romainville: 2,
  bagnolet: 3,
  bobigny: 4,
  bondy: 5
};

var CINEMA_LABELS = {
  montreuil: 'Montreuil',
  pantin: 'Pantin',
  romainville: 'Romainville',
  bagnolet: 'Bagnolet',
  bobigny: 'Bobigny',
  bondy: 'Bondy'
};

var state = {
  data: null,
  selectedWeekId: null,
  view: 'line',
  filters: { cinemas: [], dates: [] }
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCinemaClass(cinema) {
  var normalized = String(cinema || '').toLowerCase();
  if (normalized.indexOf('pantin') !== -1) return 'pantin';
  if (normalized.indexOf('romainville') !== -1 || normalized.indexOf('trianon') !== -1) return 'romainville';
  if (normalized.indexOf('bagnolet') !== -1) return 'bagnolet';
  if (normalized.indexOf('montreuil') !== -1) return 'montreuil';
  if (normalized.indexOf('bondy') !== -1) return 'bondy';
  if (normalized.indexOf('bobigny') !== -1) return 'bobigny';
  return 'default';
}

function getCurrentWeeks() {
  return normalizeData(state.data || {});
}

function getSelectedWeek() {
  var weeks = getCurrentWeeks();
  for (var i = 0; i < weeks.length; i++) {
    var entry = weeks[i];
    var value = entry.id || (entry.week ? entry.week.label : null);
    if (value === state.selectedWeekId) return entry;
  }
  return weeks.length ? weeks[0] : null;
}

function getLocalDateFromIso(dateStr) {
  if (!dateStr) return null;
  var d = new Date(dateStr + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getTodayIndex(daysConfig) {
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (var i = 0; i < daysConfig.length; i++) {
    var target = getLocalDateFromIso(daysConfig[i].date);
    if (target && target.getTime() === today.getTime()) return i;
  }
  return -1;
}

function getVisibleDays(daysConfig) {
  var todayIndex = getTodayIndex(daysConfig);
  return todayIndex >= 0 ? daysConfig.slice(todayIndex) : daysConfig;
}

function getRelativeDayLabel(day) {
  if (!day || !day.date) return day ? day.label : '';
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var target = getLocalDateFromIso(day.date);
  if (!target) return day.label;
  var diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return 'Demain';
  return day.label;
}

function formatShortDate(dateStr) {
  var parts = String(dateStr || '').split('-');
  if (parts.length < 3) return String(dateStr || '');
  return parts[2] + '/' + parts[1];
}

function getDateFilterLabel(day, index) {
  if (index === 0) return "Aujourd'hui";
  if (index === 1) return 'Demain';
  return formatShortDate(day.date);
}

function timeToMinutes(timeStr) {
  var match = /^(\d{1,2})h(\d{2})$/.exec(String(timeStr || ''));
  if (!match) return 9999;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getMovieDayItems(movie, key) {
  return movie && movie.days && movie.days[key] ? movie.days[key] : [];
}

function getBestTodayPriority(movie, week) {
  var days = week && week.days ? week.days : [];
  var todayIndex = getTodayIndex(days);
  if (todayIndex < 0) return { hasToday: false, cinemaRank: 999, timeRank: 9999 };
  var todayKey = days[todayIndex].key;
  var todayShows = getMovieDayItems(movie, todayKey);
  if (!todayShows.length) return { hasToday: false, cinemaRank: 999, timeRank: 9999 };

  var cinemaRank = 999;
  var timeRank = 9999;
  for (var i = 0; i < todayShows.length; i++) {
    var show = todayShows[i];
    var cinemaClass = getCinemaClass(show.cinema);
    cinemaRank = Math.min(cinemaRank, CINEMA_PRIORITY[cinemaClass] != null ? CINEMA_PRIORITY[cinemaClass] : 999);
    timeRank = Math.min(timeRank, timeToMinutes(show.time));
  }
  return { hasToday: true, cinemaRank: cinemaRank, timeRank: timeRank };
}

function hasVisibleShow(movie, week) {
  var visibleDays = getVisibleDays((week && week.days) ? week.days : []);
  for (var i = 0; i < visibleDays.length; i++) {
    if (getMovieDayItems(movie, visibleDays[i].key).length > 0) return true;
  }
  return false;
}

function movieMatchesFilters(movie, week) {
  var selectedCinemas = state.filters.cinemas;
  var selectedDates = state.filters.dates;
  var visibleDays = getVisibleDays((week && week.days) ? week.days : []);
  var daysToInspect = selectedDates.length
    ? visibleDays.filter(function(day) { return selectedDates.indexOf(day.key) !== -1; })
    : visibleDays;

  if (!daysToInspect.length) return false;

  for (var i = 0; i < daysToInspect.length; i++) {
    var day = daysToInspect[i];
    var items = getMovieDayItems(movie, day.key);
    if (!items.length) continue;
    if (!selectedCinemas.length) return true;
    for (var j = 0; j < items.length; j++) {
      if (selectedCinemas.indexOf(getCinemaClass(items[j].cinema)) !== -1) return true;
    }
  }
  return false;
}

function sortMoviesForWeek(movies, week) {
  return movies.slice()
    .filter(function(movie) { return hasVisibleShow(movie, week); })
    .filter(function(movie) { return movieMatchesFilters(movie, week); })
    .sort(function(a, b) {
      var aPriority = getBestTodayPriority(a, week);
      var bPriority = getBestTodayPriority(b, week);
      if (aPriority.hasToday !== bPriority.hasToday) return aPriority.hasToday ? -1 : 1;
      if (aPriority.hasToday && bPriority.hasToday) {
        if (aPriority.cinemaRank !== bPriority.cinemaRank) return aPriority.cinemaRank - bPriority.cinemaRank;
        if (aPriority.timeRank !== bPriority.timeRank) return aPriority.timeRank - bPriority.timeRank;
      }
      return String(a && a.title || '').localeCompare(String(b && b.title || ''), 'fr', { sensitivity: 'base' });
    });
}

function renderShowContent(item, mode) {
  var timeClass = mode === 'grid' ? 'grid-show-time' : 'schedule-time';
  var subClass = mode === 'grid' ? 'grid-show-sub' : 'schedule-sub';
  var version = item.version ? ' · ' + escapeHtml(item.version) : '';
  return '<span class="' + timeClass + '">' + escapeHtml(item.time) + '</span>' +
         '<span class="' + subClass + '">' + escapeHtml(item.cinema) + version + '</span>';
}

function renderWeekSwitcher(weeks, selectedId) {
  if (!weeks.length) return '';
  var options = weeks.map(function(entry) {
    var value = entry.id || (entry.week ? entry.week.label : '');
    var selected = value === selectedId ? ' selected' : '';
    return '<option value="' + escapeHtml(value) + '"' + selected + '>' +
      escapeHtml(entry.week ? entry.week.label : value) + '</option>';
  }).join('');
  return '<div class="week-switcher"><select id="week-select" class="week-select" aria-label="Choisir une semaine">' + options + '</select></div>';
}

function getFilterSummary() {
  var cinemaCount = state.filters.cinemas.length;
  var dateCount = state.filters.dates.length;
  if (!cinemaCount && !dateCount) return 'Aucun filtre';
  var parts = [];
  if (cinemaCount) parts.push(cinemaCount + ' cinéma' + (cinemaCount > 1 ? 's' : ''));
  if (dateCount) parts.push(dateCount + ' date' + (dateCount > 1 ? 's' : ''));
  return parts.join(' • ');
}

function renderTopControls(weeks, selectedId) {
  return '<div class="top-controls">' + renderWeekSwitcher(weeks, selectedId) +
    '<div class="filter-bar"><button id="filter-open-btn" class="filter-open-btn" type="button">Filtrer</button>' +
    '<span class="filter-summary">' + escapeHtml(getFilterSummary()) + '</span></div></div>';
}

function renderCinemaOption(cinemaKey) {
  var checked = state.filters.cinemas.indexOf(cinemaKey) !== -1 ? ' checked' : '';
  return '<label class="filter-option filter-option--' + cinemaKey + '">' +
    '<input class="filter-cinema-input" type="checkbox" value="' + cinemaKey + '"' + checked + '>' +
    '<span class="filter-box"></span><span class="filter-option-text">' + escapeHtml(CINEMA_LABELS[cinemaKey]) + '</span></label>';
}

function renderDateOption(day, index) {
  var checked = state.filters.dates.indexOf(day.key) !== -1 ? ' checked' : '';
  return '<label class="filter-option filter-option--date">' +
    '<input class="filter-date-input" type="checkbox" value="' + escapeHtml(day.key) + '"' + checked + '>' +
    '<span class="filter-box"></span><span class="filter-option-text">' + escapeHtml(getDateFilterLabel(day, index)) + '</span></label>';
}

function renderFilterModal(week) {
  if (!week) return '';
  var visibleDays = getVisibleDays(week.days || []);
  var cinemaOptions = ['montreuil','pantin','romainville','bagnolet','bobigny','bondy'].map(renderCinemaOption).join('');
  var dateOptions = visibleDays.map(renderDateOption).join('');
  return '<div id="filter-modal" class="filter-modal" aria-hidden="true">' +
    '<div class="filter-modal__backdrop" data-filter-close="true"></div>' +
    '<div class="filter-modal__panel" role="dialog" aria-modal="true" aria-labelledby="filter-title">' +
    '<div class="filter-modal__header"><h2 id="filter-title" class="filter-modal__title">Filtrer</h2>' +
    '<button id="filter-close-btn" class="filter-modal__close" type="button" aria-label="Fermer">×</button></div>' +
    '<div class="filter-modal__section"><div class="filter-modal__subtitle">Cinémas</div><div class="filter-options-row">' + cinemaOptions + '</div></div>' +
    '<div class="filter-modal__section"><div class="filter-modal__subtitle">Dates</div><div class="filter-options-row">' + dateOptions + '</div></div>' +
    '<div class="filter-modal__actions"><button id="filter-reset-btn" class="filter-reset-btn" type="button">Réinitialiser</button>' +
    '<button id="filter-apply-btn" class="filter-apply-btn" type="button">Valider</button></div></div></div>';
}

function renderSchedule(daysConfig, movieDays) {
  var visibleDays = getVisibleDays(daysConfig || []);
  var ths = visibleDays.map(function(day){ return '<th>' + escapeHtml(day.label) + '</th>'; }).join('');
  var tds = visibleDays.map(function(day) {
    var items = movieDays && movieDays[day.key] ? movieDays[day.key] : [];
    if (!items.length) return '<td><span class="empty">-</span></td>';
    var html = items.map(function(item){
      var cinemaClass = getCinemaClass(item.cinema);
      var href = item.bookingUrl || '#';
      var target = item.bookingUrl ? ' target="_blank" rel="noopener noreferrer"' : '';
      return '<a class="schedule-item schedule-item--' + cinemaClass + '" href="' + escapeHtml(href) + '"' + target + '>' + renderShowContent(item, 'schedule') + '</a>';
    }).join('');
    return '<td>' + html + '</td>';
  }).join('');
  return '<div class="schedule-wrap"><table class="schedule"><tr>' + ths + '</tr><tr>' + tds + '</tr></table></div>';
}

function renderGridDayBlocks(daysConfig, movieDays) {
  var visibleDays = getVisibleDays(daysConfig || []);
  return visibleDays.map(function(day) {
    var items = movieDays && movieDays[day.key] ? movieDays[day.key] : [];
    var label = getRelativeDayLabel(day);
    if (!items.length) {
      return '<div class="grid-day-block"><div class="grid-day-title">' + escapeHtml(label) + '</div><div class="empty">Aucune séance</div></div>';
    }
    var shows = items.map(function(item) {
      var cinemaClass = getCinemaClass(item.cinema);
      var href = item.bookingUrl || '#';
      var target = item.bookingUrl ? ' target="_blank" rel="noopener noreferrer"' : '';
      return '<a class="grid-show grid-show--' + cinemaClass + '" href="' + escapeHtml(href) + '"' + target + '>' + renderShowContent(item, 'grid') + '</a>';
    }).join('');
    return '<div class="grid-day-block"><div class="grid-day-title">' + escapeHtml(label) + '</div>' + shows + '</div>';
  }).join('');
}

function renderInfoButton(url, extraClass) {
  extraClass = extraClass || 'btn';
  if (!url) return '';
  return '<a class="' + extraClass + '" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Infos et bande-annonce</a>';
}

function renderPoster(url, title, className) {
  className = className || '';
  if (!url) return '';
  return '<img class="' + className + '" src="' + escapeHtml(url) + '" alt="Affiche ' + escapeHtml(title) + '">';
}

function renderListMovie(movie, week) {
  var posterHtml = movie.infoUrl
    ? '<a href="' + escapeHtml(movie.infoUrl) + '" target="_blank" rel="noopener noreferrer">' + renderPoster(movie.poster, movie.title, '') + '</a>'
    : renderPoster(movie.poster, movie.title, '');
  return '<article class="movie-list-card"><div class="poster-wrap">' + posterHtml + '</div>' +
    '<div class="movie-content"><h3 class="movie-title">' + escapeHtml(movie.title) + '</h3>' +
    '<div class="movie-meta">' + escapeHtml(movie.genre || '') + ((movie.genre && movie.duration) ? ' · ' : '') + escapeHtml(movie.duration || '') + '</div>' +
    '<div class="movie-links">' + renderInfoButton(movie.infoUrl, 'btn') + '</div>' +
    renderSchedule((week && week.days) ? week.days : [], movie.days || {}) + '</div></article>';
}

function renderGridMovie(movie, week) {
  return '<article class="movie-grid-card">' + renderPoster(movie.poster, movie.title, 'movie-grid-poster') +
    '<div class="movie-grid-overlay"><div class="movie-grid-title">' + escapeHtml(movie.title) + '</div>' +
    '<div class="movie-grid-meta">' + escapeHtml(movie.genre || '') + ((movie.genre && movie.duration) ? ' · ' : '') + escapeHtml(movie.duration || '') + '</div>' +
    '<div class="movie-grid-actions">' + renderInfoButton(movie.infoUrl, 'grid-btn') + '</div>' +
    '<div class="grid-scroll">' + renderGridDayBlocks((week && week.days) ? week.days : [], movie.days || {}) + '</div></div></article>';
}

function renderMovies(movies, week) {
  var visibleMovies = sortMoviesForWeek(movies || [], week || {});
  if (!visibleMovies.length) return '<div class="empty">Aucun film ne correspond aux filtres sélectionnés.</div>';
  return visibleMovies.map(function(movie) { return renderListMovie(movie, week) + renderGridMovie(movie, week); }).join('');
}

function setView(view) {
  state.view = view;
  var container = document.getElementById('movies-container');
  var btnLine = document.getElementById('view-line');
  var btnGrid = document.getElementById('view-grid');
  if (!container || !btnLine || !btnGrid) return;
  container.classList.toggle('view-line', view === 'line');
  container.classList.toggle('view-grid', view === 'grid');
  btnLine.classList.toggle('is-active', view === 'line');
  btnGrid.classList.toggle('is-active', view === 'grid');
}

function setupViewSwitch() {
  var btnLine = document.getElementById('view-line');
  var btnGrid = document.getElementById('view-grid');
  if (!btnLine || !btnGrid) return;
  btnLine.onclick = function() { setView('line'); };
  btnGrid.onclick = function() { setView('grid'); };
  setView(state.view);
}

function setupGridCardTouchBehavior() {
  Array.prototype.forEach.call(document.querySelectorAll('.movie-grid-card'), function(card) {
    card.onclick = function(event) {
      var clickedLink = event.target.closest('a');
      if (clickedLink) return;
      card.classList.toggle('open');
    };
  });
}

function openFilterModal() {
  var modal = document.getElementById('filter-modal');
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeFilterModal() {
  var modal = document.getElementById('filter-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function applyFiltersFromModal() {
  var cinemaInputs = Array.prototype.slice.call(document.querySelectorAll('.filter-cinema-input:checked'));
  var dateInputs = Array.prototype.slice.call(document.querySelectorAll('.filter-date-input:checked'));
  state.filters = {
    cinemas: cinemaInputs.map(function(input){ return input.value; }),
    dates: dateInputs.map(function(input){ return input.value; })
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
  var weekSelect = document.getElementById('week-select');
  var filterOpenBtn = document.getElementById('filter-open-btn');
  var filterCloseBtn = document.getElementById('filter-close-btn');
  var filterApplyBtn = document.getElementById('filter-apply-btn');
  var filterResetBtn = document.getElementById('filter-reset-btn');

  if (weekSelect) {
    weekSelect.onchange = function(event) {
      state.selectedWeekId = event.target.value;
      state.filters = { cinemas: [], dates: [] };
      renderApp();
    };
  }
  if (filterOpenBtn) filterOpenBtn.onclick = openFilterModal;
  if (filterCloseBtn) filterCloseBtn.onclick = closeFilterModal;
  if (filterApplyBtn) filterApplyBtn.onclick = applyFiltersFromModal;
  if (filterResetBtn) filterResetBtn.onclick = resetFilters;

  Array.prototype.forEach.call(document.querySelectorAll('[data-filter-close="true"]'), function(node) {
    node.onclick = closeFilterModal;
  });

  document.onkeydown = function(event) {
    if (event.key === 'Escape') closeFilterModal();
  };
}

function renderApp() {
  var switcherContainer = document.getElementById('week-switcher-container');
  var moviesContainer = document.getElementById('movies-container');
  var weeks = getCurrentWeeks();
  var selectedWeek = getSelectedWeek();

  if (!selectedWeek) {
    if (switcherContainer) switcherContainer.innerHTML = '';
    if (moviesContainer) moviesContainer.innerHTML = '<div class="empty">Aucune donnée disponible.</div>';
    return;
  }

  if (switcherContainer) {
    switcherContainer.innerHTML = renderTopControls(weeks, selectedWeek.id || (selectedWeek.week ? selectedWeek.week.label : '')) + renderFilterModal(selectedWeek.week);
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
  var moviesContainer = document.getElementById('movies-container');
  try {
    state.data = await loadData();
    var weeks = getCurrentWeeks();
    state.selectedWeekId = weeks.length ? (weeks[0].id || (weeks[0].week ? weeks[0].week.label : null)) : null;
    renderApp();
  } catch (error) {
    console.error(error);
    if (moviesContainer) {
      moviesContainer.innerHTML = '<div class="empty">Erreur : ' + escapeHtml(error.message) + '</div>';
    }
  }
}

main();
