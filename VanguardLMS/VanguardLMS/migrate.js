/*
 * Billing database initialization.
 *
 * MySQL (the existing default): offers to create the database, then syncs the
 * Users table and every billing table.
 *
 * DB_DIALECT=sqlite: skips the prompt, creates data/billing.sqlite and syncs
 * the same models. Safe to run repeatedly — sync only adds missing tables.
 */
import "dotenv/config";
import { Sequelize } from "sequelize";
import inquirer from "inquirer";
import { databaseName, dialect } from "./models/db.js";
import { dbReady, sequelize } from "./models/index.js";

const useSqlite = dialect === "sqlite";
let createDb = false;

if (!useSqlite) {
  const answers = await inquirer.prompt([
    {
      type: "confirm",
      name: "createDb",
      message: `Create database '${databaseName}' if it does not exist?`,
      default: true,
    },
  ]);
  createDb = answers.createDb;
}

let serverConnection;
try {
  if (createDb) {
    serverConnection = new Sequelize(
      "mysql",
      process.env.DB_USER || "root",
      process.env.DB_PASSWORD || "",
      {
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 3306),
        dialect: "mysql",
        logging: false,
      },
    );
    const escapedDatabaseName = databaseName.replace(/`/g, "``");
    await serverConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${escapedDatabaseName}\`;`,
    );
    console.log(`Database '${databaseName}' is ready.`);
  }

  await dbReady;
  console.log(
    `Database tables are ready (${useSqlite ? "sqlite" : "mysql"}).`,
  );
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await serverConnection?.close();
  await sequelize.close();
}
