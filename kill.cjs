const { Pool } = require("pg"); 
const pool = new Pool({ connectionString: "postgres://postgres:postgres@localhost:5432/crypto_db" }); 
pool.query("UPDATE trades SET price = 1.0 WHERE id = 10711")
  .then(()=>console.log("Triggered Pondeer Dump"))
  .finally(()=>pool.end());
