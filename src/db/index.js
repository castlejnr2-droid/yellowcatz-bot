const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DATABASE_URL || './yellowcatz.db';
let db;

function wrapDb(rawDb) {
  const save = () => {
    const data = rawDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  };

  const wrapped = {
    prepare(sql) {
      return {
        run(...params) {
          rawDb.run(sql, params);
          const res = rawDb.exec("SELECT last_insert_rowid()");
          save();
          return { lastInsertRowid: res[0]?.values[0]?.[0] };
        },
        get(...params) {
          const stmt = rawDb.prepare(sql);
          if (params.length) stmt.bind(params);
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            stmt.free();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            return row;
          }
          stmt.free();
          return undefined;
        },
        all(...params) {
          const results = [];
          const stmt = rawDb.prepare(sql);
          if (params.length) stmt.bind(params);
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row = {};
            cols.forEach((c, i) => row[c] = vals[i]);
            results.push(row);
          }
          stmt.free();
          return results;
        }
      };
    },
    exec(sql) {
      rawDb.exec(sql);
      save();
    },
    pragma() {},
    // Simple transaction: just run the function, no BEGIN/COMMIT needed for SQLite single-connection
    transaction(fn) {
      return (...args) => {
        const result = fn(...args);
        save();
        return result;
      };
    }
  };
  return wrapped;
}

let initPromise;

function getDb() {
  if (db) return db;
  return null;
}

async function getDbAsync() {
  if (db) return db;
  if (!initPromise) {
    initPromise = initSqlJs().then(SQL => {
      let rawDb;
      if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        rawDb = new SQL.Database(buffer);
      } else {
        rawDb = new SQL.Database();
      }
      db = wrapDb(rawDb);
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      db.exec(schema);
      console.log('✅ Database schema initialized');
      return db;
    });
  }
  return initPromise;
}

module.exports = { getDb, getDbAsync };
