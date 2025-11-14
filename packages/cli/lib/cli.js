#!/usr/bin/env node

"use strict";

import fs from "fs";
import untildify from "untildify";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";

import pkg from "../package.json" with { type: "json" };

import { droppy, paths, resources, log, cfg, db } from "@droppyjs/server";

import minimist from "minimist";

import daemonize from 'daemonize-process';

import { RemoteClient } from "./remote.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

util.inspect.defaultOptions.depth = 4;

const argv = minimist(process.argv.slice(2), {
  boolean: ["color", "d", "daemon", "dev"],
  string: ["user", "pass", "content", "file"],
});

if (!argv.dev) {
  process.env.NODE_ENV = "production";
}

process.title = pkg.name;
process.chdir(__dirname);

const cmds = {
  start: "start                  Start the server",
  stop: "stop                   Stop all daemonized servers",
  config: "config                 Edit the config",
  list: "list                   List users",
  add: "add <user> <pass> [p]  Add or update a user. Specify 'p' for privileged",
  del: "del <user>             Delete a user",
  build: "build                  Build client resources",
  version: "version, -v            Print version",
  "remote ping": "remote ping <url>        Check if remote instance is reachable",
  "remote list": "remote list <url> <path>  List directory contents on remote instance",
  "remote read": "remote read <url> <path>  Read file from remote instance",
  "remote write": "remote write <url> <path> [--content <text>] [--file <file>]  Write file to remote instance",
  "remote mkdir": "remote mkdir <url> <path>  Create directory on remote instance",
  "remote delete": "remote delete <url> <path>  Delete file/directory on remote instance",
  "remote move": "remote move <url> <source> <dest>  Move/rename file on remote instance",
};

const opts = {
  configdir:
    "-c, --configdir <dir>  Config directory. Default: ~/.droppy/config",
  filesdir: "-f, --filesdir <dir>   Files directory. Default: ~/.droppy/files",
  daemon: "-d, --daemon           Daemonize (background) process",
  log: "-l, --log <file>       Log to file instead of stdout",
  dev: "--dev                  Enable developing mode",
  color: "--color                Force-enable colored log output",
  nocolor: "--no-color             Force-disable colored log output",
  user: "--user <username>     Username for remote authentication",
  pass: "--pass <password>     Password for remote authentication",
  content: "--content <text>     Content to write (for write command)",
  file: "--file <path>         File path to read content from (for write command)",
};

if (argv.v || argv.V || argv.version) {
  console.info(pkg.version);
  process.exit(0);
}

if (argv.daemon || argv.d) {
  daemonize();
}

if (argv.configdir || argv.filesdir || argv.c || argv.f) {
  paths.seed(argv.configdir || argv.c, argv.filesdir || argv.f);
}

if (argv.log || argv.l) {
  try {
    log.setLogFile(
      fs.openSync(untildify(path.resolve(argv.log || argv.l)), "a", "644")
    );
  } catch (err) {
    console.error(`Unable to open log file for writing: ${err.message}`);
    process.exit(1);
  }
}

if (!argv._.length) {
  printHelp();
  process.exit(0);
}

const cmd = argv._[0];
const args = argv._.slice(1);

switch (cmd) {
  default:
    printHelp();
    break;

  case "start":
    droppy(null, true, argv.dev, (err) => {
      if (err) {
        log.error(err);
        process.exit(1);
      }
    });
    break;

  case "stop": {
    const ps = require("ps-node");
    ps.lookup({ command: pkg.name }, async (err, procs) => {
      if (err) {
        log.error(err);
        process.exit(1);
      } else {
        procs = procs.filter((proc) => Number(proc.pid) !== process.pid);
        if (!procs.length) {
          log.info("No processes found");
          process.exit(0);
        }

        const pids = await Promise.all(
          procs.map((proc) => {
            return new Promise((resolve) => {
              ps.kill(proc.pid, (err) => {
                if (err) {
                  log.error(err);
                  return process.exit(1);
                }
                resolve(proc.pid);
              });
            });
          })
        );

        if (pids.length) {
          console.info(`Killed PIDs: ${pids.join(", ")}`);
        }
        process.exit(0);
      }
    });
    break;
  }

  case "build":
    console.info("Building resources ...");
    resources.build((err) => {
      console.info(err || "Resources built successfully");
      process.exit(err ? 1 : 0);
    });
    break;

  case "version":
    console.info(pkg.version);
    break;

  case "config": {
    const ourPaths = paths.get();
    const edit = () => {
      findEditor((editor) => {
        if (!editor)
          return console.error(
            `No suitable editor found, please edit ${ourPaths.cfgFile}`
          );
        require("child_process").spawn(editor, [ourPaths.cfgFile], {
          stdio: "inherit",
        });
      });
    };
    fs.stat(ourPaths.cfgFile, (err) => {
      if (err && err.code === "ENOENT") {
        fs.mkdir(ourPaths.config, { recursive: true }, async () => {
          try {
            await cfg.init(null);
            edit();
          } catch (err) {
            console.error(new Error(err.message || err).stack);
          }
        });
      } else {
        edit();
      }
    });
    break;
  }
  case "list":
    db.load(() => {
      printUsers(db.get("users"));
    });
    break;
  case "add":
    if (args.length !== 2 && args.length !== 3) {
      printHelp();
    } else {
      db.load(() => {
        db.addOrUpdateUser(args[0], args[1], args[2] === "p", () => {
          printUsers(db.get("users"));
        });
      });
    }
    break;

  case "del":
    if (args.length !== 1) {
      printHelp();
    } else {
      db.load(() => {
        db.delUser(args[0], () => {
          printUsers(db.get("users"));
        });
      });
    }
    break;

  case "remote": {
    if (args.length < 1) {
      console.error("Error: remote command required");
      printRemoteHelp();
      process.exit(1);
    }

    const remoteCmd = args[0];
    const remoteArgs = args.slice(1);

    if (remoteArgs.length < 1) {
      console.error("Error: URL required");
      printRemoteHelp();
      process.exit(1);
    }

    const url = remoteArgs[0];
    const username = argv.user || argv.u || null;
    const password = argv.pass || argv.p || null;

    const client = new RemoteClient(url, username, password);

    try {
      switch (remoteCmd) {
        case "ping": {
          const result = await client.ping();
          console.info(JSON.stringify(result.data, null, 2));
          break;
        }

        case "list": {
          if (remoteArgs.length < 2) {
            console.error("Error: path required for list command");
            printRemoteHelp();
            process.exit(1);
          }
          const path = remoteArgs[1];
          const result = await client.list(path);
          console.info(JSON.stringify(result.data, null, 2));
          break;
        }

        case "read": {
          if (remoteArgs.length < 2) {
            console.error("Error: path required for read command");
            printRemoteHelp();
            process.exit(1);
          }
          const path = remoteArgs[1];
          const result = await client.read(path);
          if (result.data.encoding === "base64") {
            const buffer = Buffer.from(result.data.content, "base64");
            process.stdout.write(buffer);
          } else {
            console.info(result.data.content);
          }
          break;
        }

        case "write": {
          if (remoteArgs.length < 2) {
            console.error("Error: path required for write command");
            printRemoteHelp();
            process.exit(1);
          }
          const path = remoteArgs[1];
          let content = "";
          let encoding = "utf8";

          if (argv.file) {
            try {
              const fileContent = fs.readFileSync(argv.file);
              const isBinary = await isBinaryFile(argv.file);
              if (isBinary) {
                content = fileContent.toString("base64");
                encoding = "base64";
              } else {
                content = fileContent.toString("utf8");
                encoding = "utf8";
              }
            } catch (err) {
              console.error(`Error reading file: ${err.message}`);
              process.exit(1);
            }
          } else if (argv.content) {
            content = argv.content;
            encoding = "utf8";
          } else {
            console.error("Error: either --content or --file must be provided");
            printRemoteHelp();
            process.exit(1);
          }

          const result = await client.write(path, content, encoding);
          console.info(JSON.stringify(result.data, null, 2));
          break;
        }

        case "mkdir": {
          if (remoteArgs.length < 2) {
            console.error("Error: path required for mkdir command");
            printRemoteHelp();
            process.exit(1);
          }
          const path = remoteArgs[1];
          const result = await client.mkdir(path);
          console.info(JSON.stringify(result.data, null, 2));
          break;
        }

        case "delete": {
          if (remoteArgs.length < 2) {
            console.error("Error: path required for delete command");
            printRemoteHelp();
            process.exit(1);
          }
          const path = remoteArgs[1];
          const result = await client.delete(path);
          console.info(JSON.stringify(result.data || { ok: true }, null, 2));
          break;
        }

        case "move": {
          if (remoteArgs.length < 3) {
            console.error("Error: source and destination paths required for move command");
            printRemoteHelp();
            process.exit(1);
          }
          const source = remoteArgs[1];
          const destination = remoteArgs[2];
          const result = await client.move(source, destination);
          console.info(JSON.stringify(result.data || { ok: true }, null, 2));
          break;
        }

        default:
          console.error(`Error: unknown remote command '${remoteCmd}'`);
          printRemoteHelp();
          process.exit(1);
      }
    } catch (err) {
      if (err.statusCode === 401) {
        console.error(`Error: Unauthorized. Please provide valid credentials with --user and --pass`);
      } else if (err.statusCode === 403) {
        console.error(`Error: Forbidden. The instance may be in read-only mode.`);
      } else if (err.statusCode === 404) {
        console.error(`Error: Not found. The requested resource does not exist.`);
      } else if (err.code === "ECONNREFUSED") {
        console.error(`Error: Connection refused. Could not connect to ${url}`);
      } else if (err.code === "ENOTFOUND") {
        console.error(`Error: Host not found. Could not resolve ${new URL(url).hostname}`);
      } else {
        console.error(`Error: ${err.message}`);
      }
      process.exit(1);
    }
    break;
  }
}

function printHelp() {
  let help = `Usage: ${pkg.name} command [options]\n\n Commands:`;

  Object.keys(cmds).forEach((command) => {
    help += `\n   ${cmds[command]}`;
  });

  help += "\n\n Options:";

  Object.keys(opts).forEach((option) => {
    help += `\n   ${opts[option]}`;
  });

  console.info(help);
  process.exit();
}

function printUsers(users) {
  if (Object.keys(users).length === 0) {
    console.info("No users defined. Use 'add' to add one.");
  } else {
    console.info(
      `Current Users:\n${Object.keys(users)
        .map((user) => {
          return `  - ${user}`;
        })
        .join("\n")}`
    );
  }
}

function printRemoteHelp() {
  console.info(`
Remote Commands:
  remote ping <url>                    Check if remote instance is reachable
  remote list <url> <path>             List directory contents
  remote read <url> <path>             Read file content
  remote write <url> <path>            Write file (requires --content or --file)
  remote mkdir <url> <path>            Create directory
  remote delete <url> <path>           Delete file/directory
  remote move <url> <source> <dest>    Move/rename file

Remote Options:
  --user <username>                    Username for authentication
  --pass <password>                    Password for authentication
  --content <text>                     Content to write (for write command)
  --file <path>                        File path to read from (for write command)

Examples:
  droppy remote ping http://localhost:8989
  droppy remote list http://localhost:8989 / --user admin --pass secret
  droppy remote read http://localhost:8989 /file.txt --user admin --pass secret
  droppy remote write http://localhost:8989 /new.txt --content "Hello" --user admin --pass secret
  droppy remote write http://localhost:8989 /file.txt --file ./local.txt --user admin --pass secret
  droppy remote mkdir http://localhost:8989 /newdir --user admin --pass secret
  droppy remote delete http://localhost:8989 /old.txt --user admin --pass secret
  droppy remote move http://localhost:8989 /old.txt /new.txt --user admin --pass secret
`);
}

async function isBinaryFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath, { encoding: null });
    const chunk = buffer.slice(0, 512);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function findEditor(cb) {
  const editors = ["vim", "nano", "vi", "npp", "pico", "emacs", "notepad"];
  const basename = require("path").basename;
  const which = require("which");
  const userEditor = basename(process.env.VISUAL || process.env.EDITOR);

  if (!editors.includes(userEditor)) {
    editors.unshift(userEditor);
  }

  (function find(editor) {
    try {
      cb(which.sync(editor));
    } catch {
      if (editors.length) {
        find(editors.shift());
      } else {
        cb();
      }
    }
  })(editors.shift());
}
