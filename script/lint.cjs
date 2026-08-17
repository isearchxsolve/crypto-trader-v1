"use strict";

// Dependency-free source hygiene gate. TypeScript itself supplies the semantic
// check; this gate adds parser validation and guards against two classes of
// production regressions that generic lint rules routinely miss in this repo:
// logging raw environment values and committing credential-shaped assignments.
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const ROOTS = ["server", "tests", "shared"];
const findings = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : (entry.name.endsWith(".ts") ? [file] : []);
  });
}

function isProcessEnvAccess(node) {
  return ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "process"
    && node.expression.name.text === "env";
}

function hasProcessEnvAccess(node) {
  let found = false;
  const visit = child => {
    if (isProcessEnvAccess(child)) { found = true; return; }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isLogCall(node) {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ["log", "info", "warn", "error", "debug"].includes(node.expression.name.text)
    && (ts.isIdentifier(node.expression.expression) || ts.isPropertyAccessExpression(node.expression.expression));
}

for (const root of ROOTS) {
  for (const file of walk(path.join(ROOT, root))) {
    const source = fs.readFileSync(file, "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
    for (const diagnostic of parsed.parseDiagnostics) {
      const where = diagnostic.start === undefined ? "" : `:${parsed.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
      findings.push(`${path.relative(ROOT, file)}${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    const lines = source.split(/\r?\n/);
    const visit = node => {
      if (isLogCall(node) && node.arguments.some(hasProcessEnvAccess)) {
        const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
        findings.push(`${path.relative(ROOT, file)}:${line}: logging process.env values is prohibited`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    lines.forEach((line, index) => {
      if (/\b(?:API_KEY|PRIVATE_KEY|SECRET|TOKEN|PASSWORD)\s*=\s*["'][^"']{12,}["']/i.test(line)) {
        findings.push(`${path.relative(ROOT, file)}:${index + 1}: credential-shaped literal is prohibited`);
      }
    });
  }
}

if (findings.length) {
  console.error("Source hygiene failed:\n" + findings.join("\n"));
  process.exit(1);
}
console.log("Source hygiene passed: TypeScript parsed and secret-log checks found no violations.");
