"use strict";

// Makes ts-node ignore warnings, so mocha --watch does work
process.env.TS_NODE_IGNORE_WARNINGS = "TRUE";
// Sets the correct tsconfig for testing
process.env.TS_NODE_PROJECT = "tsconfig.json";
// Make ts-node respect the "include" key in tsconfig.json
process.env.TS_NODE_FILES = "TRUE";
// The root tsconfig sets noEmit, because it only configures type checking - ts-node has to emit.
// TypeScript 6 then refuses with TS5011 unless rootDir is explicit, because the common source
// directory of a single compiled file is that file's own directory.
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ rootDir: ".", noEmit: false });

// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
	throw e;
});

// enable the should interface with sinon
// and load chai-as-promised and sinon-chai by default
const sinonChai = require("sinon-chai");
const chaiAsPromised = require("chai-as-promised");
const { should, use } = require("chai");

should();
use(sinonChai);
use(chaiAsPromised);