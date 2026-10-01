import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createService, handleMessage, TOOLS } from "./server.mjs";
import { parsePlanFile } from "./model.mjs";

function completeIntake(service) {
  const { session_id } = service.start_intake();
  service.answer_intake({ session_id, step: 0, answers: { name: "Codex handoff", householdMode: "single", state: "WA", primaryAge: 58, primaryRetirementAge: 62, planningHorizonAge: 92 } });
  service.answer_intake({ session_id, step: 1, answers: { cash: 150000, taxable: 750000, taxableBasis: 520000, pretax: 1000000, roth: 250000 } });
  service.answer_intake({ session_id, step: 2, answers: { primarySalary: 220000, socialSecurity: 30000 } });
  const last = service.answer_intake({ session_id, step: 3, answers: { coreExpenses: 120000, healthcareExpenses: 24000, medicareHealthcareExpenses: 18000, travelExpenses: 30000, otherExpenses: 12000 } });
  assert.deepEqual(last.missing_for_model, []);
  return session_id;
}

test("requires supplied core answers before modeling or exporting", async () => {
  const service = createService();
  const { session_id } = service.start_intake();
  assert.throws(() => service.run_model({ session_id }), /Complete these intake fields/);
  await assert.rejects(service.export_plan({ session_id }), /Complete these intake fields/);
  assert.throws(() => service.answer_intake({ session_id, step: 0, answers: { primaryAge: -1 } }), /between 18 and 120/);
});

test("does not treat normalized example values in a partial plan file as supplied answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retirebridge-partial-"));
  try {
    const path = join(directory, "partial.retirebridge.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ app: "retirebridge", version: 1, form: { name: "Partial" } }));
    const service = createService();
    const opened = await service.open_plan_file({ path });
    assert.ok(opened.missing_for_model.includes("cash"));
    assert.throws(() => service.run_model({ session_id: opened.session_id }), /Complete these intake fields/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("models a completed intake and exports a website-compatible plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retirebridge-plugin-"));
  try {
    const service = createService();
    const session_id = completeIntake(service);
    const planned = service.run_model({ session_id });
    assert.equal(planned.model, "planned_path");
    assert.equal(planned.planName, "Codex handoff");
    assert.ok(Number.isFinite(planned.endingLiquidAssets));
    const simulated = service.run_model({ session_id, model: "monte_carlo", run_count: 20 });
    assert.equal(simulated.simulation.runCount, 20);
    assert.ok(service.run_model({ session_id, model: "levers" }).levers.length > 0);
    assert.ok(service.run_model({ session_id, model: "tax_comparison" }).strategies.length > 0);
    const exported = await service.export_plan({ session_id, directory });
    assert.equal(exported.website_url, "https://restoftheroad.com/import?source=codex");
    const parsed = parsePlanFile(JSON.parse(await readFile(exported.file_path, "utf8")));
    assert.equal(parsed.form.name, "Codex handoff");
    assert.equal(parsed.form.primaryAge, 58);
    const reopened = await service.open_plan_file({ path: exported.file_path });
    assert.deepEqual(reopened.missing_for_model, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependent household answers create explicit dependent costs in the exported form", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retirebridge-dependent-"));
  try {
    const service = createService();
    const session_id = completeIntake(service);
    service.answer_intake({ session_id, step: 0, answers: { householdMode: "single_dependents", dependentCount: 2, dependentYears: 6, annualDependentCost: 10000 } });
    const exported = await service.export_plan({ session_id, directory });
    const parsed = parsePlanFile(JSON.parse(await readFile(exported.file_path, "utf8")));
    assert.equal(parsed.form.dependents.length, 2);
    assert.deepEqual(parsed.form.dependents.map(dependent => dependent.annualCost), [10000, 10000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP advertises usable tools and returns tool errors as tool results", async () => {
  const service = createService();
  const initialized = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, service);
  assert.equal(initialized.result.serverInfo.name, "retirebridge");
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, service);
  assert.equal(listed.result.tools.length, TOOLS.length);
  const call = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_intake", arguments: {} } }, service);
  assert.equal(JSON.parse(call.result.content[0].text).step_name, "Household");
  const error = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_model", arguments: { session_id: "bad" } } }, service);
  assert.equal(error.result.isError, true);
});
