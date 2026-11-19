import { Sequelize } from "sequelize";
import fs from "fs";
import path from "path";

/*
 * Database connection.
 *
 * The LMS runs on SQLite out of the box so it can be started on any machine
 * with no database server. Set DB_DIALECT=mysql (plus the DB_* variables) to
 * point the same models at MySQL, e.g. the Laragon install used by XianFire.
 */
const dialect = (process.env.DB_DIALECT || "sqlite").toLowerCase();

let sequelize;

if (dialect === "mysql") {
  sequelize = new Sequelize(
    process.env.DB_NAME || "LMS_IND",
    process.env.DB_USER || "root",
    process.env.DB_PASSWORD || "",
    {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 3306),
      dialect: "mysql",
      logging: false,
    }
  );
} else {
  const storage =
    process.env.DB_STORAGE ||
    path.join(process.cwd(), "data", "lms.sqlite");
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage,
    logging: false,
  });
}

export { sequelize };
