const { Client } = require('pg');
const client = new Client({ connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' });
client.connect().then(() => {
  return client.query('CREATE DATABASE crypto_paper');
}).then(() => {
  console.log("Database created");
  process.exit(0);
}).catch((e) => {
  if (e.message.includes('already exists')) {
    console.log("Database already exists");
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
