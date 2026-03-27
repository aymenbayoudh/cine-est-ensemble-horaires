async function loadData() {
  const response = await fetch('../data/latest.json');
  if (!response.ok) {
    throw new Error('Impossible de charger data/latest.json');
  }
  return response.json();
}

function renderSchedule(daysConfig, movieDays) {
  const ths = daysConfig.map(day => `<th>${day.label}</th>`).join('');

  const tds = daysConfig.map(day => {
    const items = movieDays[day.key] || [];

    if (!items.length) {
      return `<td><span class="empty">-</span></td>`;
    }

    const html = items.map(item => {
      return `
        <a class="schedule-item" href="${item.bookingUrl}" target="_blank" rel="noopener noreferrer">
          <span class="schedule-time">${item.time}</span>
          <span class="schedule-cinema">— ${item.cinema}</span>
        </a>
      `;
    }).join('');

    return `<td>${html}</td>`;
  }).join('');

  return `
    <table class="schedule">
      <thead>
        <tr>${ths}</tr>
      </thead>
      <tbody>
        <tr>${tds}</tr>
      </tbody>
    </table>
  `;
}

function renderMovie(movie, week) {
  return `
    <article class="movie-card">
      <div class="poster-wrap">
        <a href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${movie.poster}" alt="${movie.title}">
        </a>
      </div>

      <div class="movie-content">
        <h2 class="movie-title">${movie.title}</h2>
        <div class="movie-meta">${movie.genre} | ${movie.duration}</div>

        <div class="movie-links">
          <a class="btn" href="${movie.infoUrl}" target="_blank" rel="noopener noreferrer">Horaires et Infos</a>
          <a class="btn" href="${movie.trailerUrl}" target="_blank" rel="noopener noreferrer">Bande-annonce</a>
        </div>

        ${renderSchedule(week.days, movie.days)}
      </div>
    </article>
  `;
}

async function main() {
  const container = document.getElementById('movies-container');

  try {
    const data = await loadData();

    container.innerHTML = `
      <p><strong>${data.week.label}</strong></p>
      ${data.movies.map(movie => renderMovie(movie, data.week)).join('')}
    `;
  } catch (error) {
    console.error(error);
    container.innerHTML = `<p>Erreur : ${error.message}</p>`;
  }
}

main();
