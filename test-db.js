const initSqlJs = require('sql.js');
const fs = require('fs');

initSqlJs().then(SQL => {
  const buf = fs.readFileSync('./yellowcatz.db');
  const db = new SQL.Database(buf);
  
  // Check current state
  let r = db.exec("SELECT telegram_id, gamble_balance, last_collect_at FROM users WHERE telegram_id='697997936'");
  console.log('Before:', JSON.stringify(r));
  
  // Simulate recordCollection
  const telegramId = 697997936; // numeric, as Telegram sends it
  console.log('Type of telegramId:', typeof telegramId, 'String:', String(telegramId));
  
  // This is what the wrapper does: rawDb.run(sql, params)
  // params is [...params] from the spread
  db.run("UPDATE users SET gamble_balance = gamble_balance + ?, spot_balance = spot_balance + ?, updated_at = datetime('now') WHERE telegram_id = ?",
    [100, 0, String(telegramId)]);
  
  r = db.exec("SELECT telegram_id, gamble_balance FROM users WHERE telegram_id='697997936'");
  console.log('After:', JSON.stringify(r));
  
  // Check collections table
  r = db.exec("SELECT * FROM collections WHERE user_id='697997936'");
  console.log('Collections:', JSON.stringify(r));
  
  const data = db.export();
  fs.writeFileSync('./yellowcatz.db', Buffer.from(data));
});
