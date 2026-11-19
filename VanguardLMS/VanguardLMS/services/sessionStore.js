import session from "express-session";
import { Op } from "sequelize";
import { Session } from "../models/index.js";

function expiryFor(sess) {
  const raw = sess?.cookie?.expires;
  const date = raw ? new Date(raw) : null;
  if (date && !Number.isNaN(date.getTime())) return date;
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

export class SequelizeSessionStore extends session.Store {
  get(sid, callback) {
    Session.findByPk(String(sid))
      .then((row) => {
        if (!row) return callback(null, null);
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
          return row.destroy().then(() => callback(null, null));
        }
        let parsed;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          return row.destroy().then(() => callback(null, null));
        }
        return callback(null, parsed);
      })
      .catch((error) => callback(error));
  }

  set(sid, sess, callback = () => {}) {
    Session.upsert({
      sid: String(sid),
      data: JSON.stringify(sess),
      expiresAt: expiryFor(sess),
    })
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  destroy(sid, callback = () => {}) {
    Session.destroy({ where: { sid: String(sid) } })
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  touch(sid, sess, callback = () => {}) {
    Session.update(
      { expiresAt: expiryFor(sess) },
      { where: { sid: String(sid) } }
    )
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  clearExpired() {
    return Session.destroy({
      where: { expiresAt: { [Op.lte]: new Date() } },
    }).catch((error) => console.warn("[session] Cleanup failed:", error.message));
  }
}
