const initSqlJs = require('sql.js');
const fs = require('fs');

initSqlJs().then(SQL => {
  const buf = fs.readFileSync('./yellowcatz.db');
  const db = new SQL.Database(buf);
  
  // Check current balance
  let r = db.exec("SELECT gamble_balance FROM users WHERE telegram_id='697997936'");
  console.log('Current balance:', r[0]?.values[0]?.[0]);
  
  // Try the exact UPDATE that recordCollection does
  console.log('Running UPDATE with params [500, 0, "697997936"]...');
  db.run("UPDATE users SET gamble_balance = gamble_balance + ?, spot_balance = spot_balance + ?, updated_at = datetime('now') WHERE telegram_id = ?", 
    [500, 0, '697997936']);
  
  r = db.exec("SELECT gamble_balance FROM users WHERE telegram_id='697997936'");
  console.log('After UPDATE:', r[0]?.values[0]?.[0]);
  
  // Check how many rows changed
  const changes = db.getRowsModified();
  console.log('Rows modified:', changes);
});
