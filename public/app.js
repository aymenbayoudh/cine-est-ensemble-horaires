async function loadData() {
  const response = await fetch('../data/latest.json');
  if (!response.ok) {
    throw new Error('Impossible de charger data/latest.json');
  }
  return response.json();
}

function formatShowtimeLabel(item) {
  const version = item.version ? ` - ${item.version}` : '';
  return `${item.time}${version} ${item.cinema}`;
}

function getRelativeDayLabel(day) {
  if (!day.date) return day.label;

  const today = new Date();
  const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const target = new Date(`${day.date}T00:00:00`);
  const localTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());

  const diffMs = localTarget - localToday;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return "Demain";
  return day.label;
}

function renderSchedule(daysConfig, movieDays) {
  const ths = daysConfig.map(day => `<th>${day.label}</th>`).join('');

  const tds = daysConfig.map(day => {
    const items = movieDays[day.key] || [];

    if (!items.length) {
      return `<td><span class="empty">-</span></td>`;
    }

    const html = items.map(item => `
      <a class="schedule-item" href="${item.bookingUrl}" target="_blank" rel="noopener noreferrer">
        <span class="schedule-main">${formatShowtimeLabel(item)}</span>
      </a>
    `).join('');

    return `<td>${html}</td>`;
  }).join('');

  return `
    <div class="schedule-wrap">
      <table class="schedule">
        <thead>
          <tr>${ths}</tr>
        </thead>
        <tbody>
          <tr>${tds}</tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderGridDayBlocks(daysConfig, movieDays) {
  return daysConfig.map(day => {
    const items = movieDays[day.key] || [];
    const label = getRelativeDayLabel(day);

    if (!items.length) {
      return `
        <div class="grid-day-block">
          <div class="grid-day-title">${label}</div>
          <div class="grid-empty">Aucune séance</div>
        </div>
      `;
    }

    return `
      <div class="grid-day-block">
        <div class="grid-day-title">${label}</div>
        ${items.map(item => `
          <a class="grid-show" href="${item.bookingUrl}" target="_blank" rel="noopener noreferrer">
            ${formatShowtimeLabel(item)}
          </a>
        `).join('')}
      </div>
    `;
  }).join('');
}

function renderListMovie(movie, week) {
  return `
    <article class="movie-list-card">
      <div class="poster-wrap">
        <a href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${movie.poster}" alt="${movie.title}" />
        </a>
      </div>

      <div class="movie-content">
        <h2 class="movie-title">${movie.title}</h2>
        <div class="movie-meta">${movie.genre} | ${movie.duration}</div>

        <div class="movie-links">
          <a class="btn" href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">
            Infos et bande-annonce
          </a>
        </div>

        ${renderSchedule(week.days, movie.days)}
      </div>
    </article>
  `;
}

function renderGridMovie(movie, week) {
  return `
    <article class="movie-grid-card">
      <a href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">
        <img class="movie-grid-poster" src="${movie.poster}" alt="${movie.title}" />
      </a>

      <div class="movie-grid-overlay">
        <div class="movie-grid-title">${movie.title}</div>
        <div class="movie-grid-meta">${movie.genre} | ${movie.duration}</div>

        <div class="movie-grid-actions">
          <a class="grid-btn" href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">
            Infos et bande-annonce
          </a>
        </div>

        <div class="grid-scroll">
          ${renderGridDayBlocks(week.days, movie.days)}
        </div>
      </div>
    </article>
  `;
}

function renderAllMovies(data) {
  return data.movies.map(movie => `
    ${renderListMovie(movie, data.week)}
    ${renderGridMovie(movie, data.week)}
  `).join('');
}

function setupViewSwitch() {
  const container = document.getElementById('movies-container');
  const btnLine = document.getElementById('view-line');
  const btnGrid = document.getElementById('view-grid');

  if (!container || !btnLine || !btnGrid) return;

  btnLine.addEventListener('click', () => {
    container.classList.remove('view-grid');
    container.classList.add('view-line');
    btnLine.classList.add('is-active');
    btnGrid.classList.remove('is-active');
  });

  btnGrid.addEventListener('click', () => {
    container.classList.remove('view-line');
    container.classList.add('view-grid');
    btnGrid.classList.add('is-active');
    btnLine.classList.remove('is-active');
  });
}

function setupGridCardTouchBehavior() {
  document.querySelectorAll('.movie-grid-card').forEach(card => {
    card.addEventListener('click', (event) => {
      const clickedLink = event.target.closest('a');
      if (clickedLink) return;
      card.classList.toggle('open');
    });
  });
}

async function main() {
  const container = document.getElementById('movies-container');

  try {
    const data = await loadData();

    container.innerHTML = `
      <p><strong>${data.week.label}</strong></p>
      ${renderAllMovies(data)}
    `;

    setupViewSwitch();
    setupGridCardTouchBehavior();
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p>Erreur : ${error.message}</p>`;
  }
}

main();
