const { Client } = require('pg');
const c = new Client({
  connectionString: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow',
});
c.connect()
  .then(() =>
    c.query('UPDATE _db_migrations SET checksum = $1 WHERE id = 112', ['afd8c57cc278143a']),
  )
  .then((r) => {
    console.log('Updated', r.rowCount, 'row');
    c.end();
  })
  .catch((e) => {
    console.error(e.message);
    c.end();
  });
