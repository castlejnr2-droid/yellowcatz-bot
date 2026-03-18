const initSqlJs = require('sql.js');
const fs = require('fs');
initSqlJs().then(SQL => {
  const buf = fs.readFileSync('./yellowcatz.db');
  const db = new SQL.Database(buf);
  db.run("UPDATE users SET gamble_balance = 4439 WHERE telegram_id = '697997936'");
  const r = db.exec("SELECT telegram_id, username, gamble_balance, spot_balance FROM users");
  console.log(JSON.stringify(r[0].values, null, 2));
  fs.writeFileSync('./yellowcatz.db', Buffer.from(db.export()));
  console.log('Fixed!');
});
