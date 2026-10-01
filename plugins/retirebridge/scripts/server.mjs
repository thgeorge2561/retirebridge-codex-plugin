import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlanFile, defaultFormState, evaluatePlan, parsePlanFile } from "./model.mjs";

function websiteUrl() {
  const base = new URL(process.env.RETIREBRIDGE_SITE_URL ?? "https://restoftheroad.com");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw new Error("RETIREBRIDGE_SITE_URL must use HTTPS or local HTTP");
  }
  return new URL("/import?source=codex", base).toString();
}
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_SESSIONS = 20;

const STEPS = [
  { label: "Household", fields: [
    ["name", "Name this plan"], ["householdMode", "Who is included: one adult, two adults, or dependents?"],
    ["state", "Which US state should the plan use?"], ["filingStatus", "What tax filing status should the model use?"],
    ["primaryAge", "What is the first adult's current age?"], ["primaryRetirementAge", "At what age might the first adult retire?"],
    ["secondaryAge", "What is the second adult's current age?"], ["secondaryRetirementAge", "At what age might the second adult retire?"],
    ["dependentCount", "How many dependents are included?"], ["dependentYears", "For how many more years are dependent costs expected?"],
    ["annualDependentCost", "What is the annual cost per dependent?"],
    ["planningHorizonAge", "Through what age should the plan run?"],
  ] },
  { label: "Savings", fields: [
    ["cash", "How much is held in cash?"], ["taxable", "What is the taxable brokerage balance?"],
    ["taxableBasis", "What is the cost basis of the taxable brokerage balance?"],
    ["pretax", "What is in pre-tax retirement accounts?"], ["roth", "What is in Roth accounts?"],
    ["concentratedStock", "What is in concentrated company stock?"], ["concentratedStockBasis", "What is its cost basis?"],
    ["homeEquity", "What is the home equity? This is tracked but not spent."],
    ["mortgagePayment", "What is the annual mortgage payment?"], ["mortgagePayoffYears", "In how many years will the mortgage be paid off?"],
  ] },
  { label: "Income", fields: [
    ["primarySalary", "What is the first adult's annual salary until retirement?"],
    ["secondarySalary", "What is the second adult's annual salary until retirement?"],
    ["socialSecurity", "What annual Social Security amount should the plan use? Enter 0 if unknown."],
    ["socialSecurityStartAge", "At what age should Social Security start?"],
    ["pension", "What is the annual pension amount?"], ["rentalIncome", "What is annual rental income?"],
    ["annuityIncome", "What is annual annuity income?"], ["otherGuaranteedIncome", "What other guaranteed annual income is there?"],
  ] },
  { label: "Spending", fields: [
    ["coreExpenses", "What are annual core retirement expenses?"],
    ["healthcareExpenses", "What are annual healthcare expenses before Medicare?"],
    ["medicareHealthcareExpenses", "What are annual healthcare expenses after Medicare?"],
    ["travelExpenses", "What are annual travel expenses?"], ["otherExpenses", "What are other annual expenses?"],
    ["spendingFlexibilityPercent", "What fraction of spending could be reduced in a difficult year? Use 0.12 for 12%."],
  ] },
  { label: "Outlook", fields: [
    ["annualReturn", "What annual investment return assumption should the model use? Use 0.055 for 5.5%."],
    ["generalInflation", "What general inflation assumption should it use? Use 0.027 for 2.7%."],
    ["healthcareInflation", "What healthcare inflation assumption should it use? Use 0.055 for 5.5%."],
    ["stateTaxRate", "What simplified state tax rate should it use? Use 0.05 for 5%."],
    ["monteCarloProfile", "What simulation profile should it use?"],
    ["withdrawalStrategy", "Which withdrawal strategy should it use?"],
    ["annualRothConversion", "What annual Roth conversion amount should it test?"],
  ] },
];

const ENUMS = {
  householdMode: ["single", "single_dependents", "couple", "couple_dependents"],
  filingStatus: ["single", "married_joint"],
  monteCarloProfile: ["balanced", "conservative", "optimistic", "inflation_shock", "poor_sequence"],
  withdrawalStrategy: ["taxable_first", "magi_guardrail", "pretax_balanced"],
};
const AGE_FIELDS = new Set(["primaryAge", "primaryRetirementAge", "secondaryAge", "secondaryRetirementAge", "planningHorizonAge", "socialSecurityStartAge"]);
const RATE_FIELDS = new Set(["spendingFlexibilityPercent", "annualReturn", "generalInflation", "healthcareInflation", "stateTaxRate"]);
const REQUIRED = ["householdMode", "state", "primaryAge", "primaryRetirementAge", "planningHorizonAge", "cash", "taxable", "pretax", "roth", "primarySalary", "socialSecurity", "coreExpenses", "healthcareExpenses", "medicareHealthcareExpenses", "travelExpenses", "otherExpenses"];
const FIELDS = new Map(STEPS.flatMap((step, stepIndex) => step.fields.map(([key, question]) => [key, { stepIndex, question }])));

function blankForm() {
  return {
    ...defaultFormState,
    householdMode: "single",
    filingStatus: "single",
    primaryAge: 0,
    primaryRetirementAge: 0,
    secondaryAge: 0,
    secondaryRetirementAge: 0,
    dependentCount: 0,
    dependentYears: 0,
    annualDependentCost: 0,
    dependents: [],
    cash: 0, taxable: 0, taxableBasis: 0, pretax: 0, roth: 0,
    concentratedStock: 0, concentratedStockBasis: 0, homeEquity: 0,
    mortgagePayment: 0, mortgagePayoffYears: 0,
    primarySalary: 0, secondarySalary: 0, socialSecurity: 0,
    pension: 0, rentalIncome: 0, annuityIncome: 0, otherGuaranteedIncome: 0,
    coreExpenses: 0, healthcareExpenses: 0, medicareHealthcareExpenses: 0,
    travelExpenses: 0, otherExpenses: 0,
  };
}

function neededFields(form, supplied) {
  const required = [...REQUIRED];
  if (form.householdMode === "couple" || form.householdMode === "couple_dependents") {
    required.push("secondaryAge", "secondaryRetirementAge", "secondarySalary");
  }
  if (form.householdMode === "single_dependents" || form.householdMode === "couple_dependents") {
    required.push("dependentCount", "dependentYears", "annualDependentCost");
  }
  if (form.taxable > 0) required.push("taxableBasis");
  if (form.concentratedStock > 0) required.push("concentratedStockBasis");
  return required.filter(key => !supplied.has(key));
}

function fieldSchema(key) {
  if (ENUMS[key]) return { type: "string", enum: ENUMS[key] };
  if (key === "name" || key === "state") return { type: "string" };
  return { type: "number" };
}

function validateAnswer(key, value) {
  if (!FIELDS.has(key)) throw new Error(`Unsupported field: ${key}`);
  if (ENUMS[key]) {
    if (!ENUMS[key].includes(value)) throw new Error(`${key} must be one of ${ENUMS[key].join(", ")}`);
    return value;
  }
  if (key === "name") {
    if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("name must be 1 to 100 characters");
    return value.trim();
  }
  if (key === "state") {
    if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) throw new Error("state must be a two-letter US state code");
    return value.toUpperCase();
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  if (key === "dependentCount" && (!Number.isInteger(value) || value < 1 || value > 20)) throw new Error("dependentCount must be an integer from 1 to 20");
  if (key === "dependentYears" && (!Number.isInteger(value) || value < 1 || value > 40)) throw new Error("dependentYears must be an integer from 1 to 40");
  if (AGE_FIELDS.has(key) && (value < 18 || value > 120)) throw new Error(`${key} must be between 18 and 120`);
  if (RATE_FIELDS.has(key) && (value < 0 || value > 1)) throw new Error(`${key} must be a decimal fraction between 0 and 1`);
  if (!AGE_FIELDS.has(key) && !RATE_FIELDS.has(key) && (value < 0 || value > 1e12)) throw new Error(`${key} must be between 0 and 1 trillion`);
  return value;
}

function stepView(session, stepIndex) {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= STEPS.length) throw new Error("step must be 0 to 4");
  const step = STEPS[stepIndex];
  return {
    session_id: session.id,
    step: stepIndex,
    step_name: step.label,
    fields: step.fields.map(([key, question]) => ({ key, question, value: session.form[key], source: session.supplied.has(key) ? "supplied" : "default", ...(ENUMS[key] ? { options: ENUMS[key] } : {}), ...(RATE_FIELDS.has(key) ? { unit: "decimal fraction" } : {}), required: neededFields(session.form, session.supplied).includes(key) })),
    missing_for_model: neededFields(session.form, session.supplied),
    note: "Unanswered financial fields start at zero. Other displayed values are model defaults until supplied. Do not present defaults as the user's facts."
  };
}

function safeSessionId(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("A valid session_id is required");
  return value;
}

export function createService({ now = Date.now, read = readFile, fileStat = stat, write = writeFile, makeDirectory = mkdir, userHome = homedir() } = {}) {
  const sessions = new Map();

  function getSession(id) {
    const session = sessions.get(safeSessionId(id));
    if (!session || now() - session.touchedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      throw new Error("Intake session expired. Start a new intake or open a saved plan file.");
    }
    session.touchedAt = now();
    return session;
  }
  function addSession(form, supplied = new Set()) {
    for (const [id, session] of sessions) if (now() - session.touchedAt > SESSION_TTL_MS) sessions.delete(id);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const session = { id: randomUUID(), form, supplied, touchedAt: now() };
    sessions.set(session.id, session);
    return session;
  }
  function ready(session) {
    const missing = neededFields(session.form, session.supplied);
    if (missing.length) throw new Error(`Complete these intake fields before modeling or exporting: ${missing.join(", ")}`);
    return session.form;
  }

  return {
    start_intake() {
      return stepView(addSession(blankForm()), 0);
    },
    get_intake({ session_id, step = 0 } = {}) {
      return stepView(getSession(session_id), step);
    },
    answer_intake({ session_id, step, answers } = {}) {
      const session = getSession(session_id);
      if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) throw new Error("step must be 0 to 4");
      if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length === 0) throw new Error("answers must be a non-empty object");
      const next = { ...session.form };
      const supplied = new Set(session.supplied);
      for (const [key, value] of Object.entries(answers)) {
        if (FIELDS.get(key)?.stepIndex !== step) throw new Error(`${key} belongs to another step or is unsupported`);
        next[key] = validateAnswer(key, value);
        supplied.add(key);
      }
      if (Object.hasOwn(answers, "householdMode") && !Object.hasOwn(answers, "filingStatus")) {
        next.filingStatus = next.householdMode.startsWith("single") ? "single" : "married_joint";
      }
      if (["dependentCount", "dependentYears", "annualDependentCost"].some(key => Object.hasOwn(answers, key))) {
        next.dependents = Array.from({ length: next.dependentCount }, (_, index) => {
          const existing = session.form.dependents[index];
          return {
            id: existing?.id ?? `dependent-${index + 1}`,
            label: existing?.label ?? `Dependent ${index + 1}`,
            yearsRemaining: Object.hasOwn(answers, "dependentYears") ? next.dependentYears : existing?.yearsRemaining ?? next.dependentYears,
            annualCost: Object.hasOwn(answers, "annualDependentCost") ? next.annualDependentCost : existing?.annualCost ?? next.annualDependentCost
          };
        });
      }
      if (next.taxableBasis > next.taxable && next.taxable > 0) throw new Error("taxableBasis cannot exceed taxable balance");
      if (next.concentratedStockBasis > next.concentratedStock && next.concentratedStock > 0) throw new Error("concentratedStockBasis cannot exceed concentratedStock balance");
      session.form = next;
      session.supplied = supplied;
      return stepView(session, Math.min(step + 1, STEPS.length - 1));
    },
    async open_plan_file({ path } = {}) {
      if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".retirebridge.json")) throw new Error("path must be an absolute .retirebridge.json file path");
      const details = await fileStat(path);
      if (!details.isFile() || details.size > MAX_PLAN_BYTES) throw new Error("Plan file must be a regular file under 1 MB");
      const raw = JSON.parse(await read(path, "utf8"));
      const plan = parsePlanFile(raw);
      const supplied = new Set([...FIELDS.keys()].filter(key => Object.hasOwn(raw.form, key)));
      return stepView(addSession(plan.form, supplied), 0);
    },
    run_model({ session_id, model = "planned_path", run_count = 200 } = {}) {
      const form = ready(getSession(session_id));
      if (!["planned_path", "monte_carlo", "levers", "tax_comparison"].includes(model)) throw new Error("Unknown model");
      if (!Number.isInteger(run_count) || run_count < 20 || run_count > 500) throw new Error("run_count must be between 20 and 500");
      return evaluatePlan(form, model, run_count);
    },
    async export_plan({ session_id, directory } = {}) {
      const form = ready(getSession(session_id));
      evaluatePlan(form, "planned_path");
      const url = websiteUrl();
      const destination = directory ?? join(userHome, "Downloads");
      if (typeof destination !== "string" || !isAbsolute(destination)) throw new Error("directory must be an absolute path");
      await makeDirectory(destination, { recursive: true, mode: 0o700 });
      const stamp = new Date(now()).toISOString().slice(0, 10).replaceAll("-", "");
      const path = join(destination, `retirebridge-plan-${stamp}-${randomUUID().slice(0, 8)}.retirebridge.json`);
      await write(path, JSON.stringify(createPlanFile(form), null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return { file_path: path, website_url: url, next_step: "Open the website URL, select this plan file, review the inputs, then choose Open in planner. The file is not uploaded by the import page." };
    },
  };
}

export const TOOLS = [
  { name: "start_intake", description: "Start a locally modeled RetireBridge intake. Returns the first of five website-aligned steps. Financial values start at zero; assumptions are defaults until supplied.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_intake", description: "Read a step and see which fields the user supplied versus model defaults.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, step: { type: "integer", minimum: 0, maximum: 4 } }, required: ["session_id"], additionalProperties: false } },
  { name: "answer_intake", description: "Set structured answers for one intake step. Money is annual USD or balances; rates are decimal fractions. Ask the user for facts instead of inventing values.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, step: { type: "integer", minimum: 0, maximum: 4 }, answers: { type: "object", properties: Object.fromEntries([...FIELDS].map(([key]) => [key, fieldSchema(key)])), additionalProperties: false } }, required: ["session_id", "step", "answers"], additionalProperties: false } },
  { name: "open_plan_file", description: "Open a user-provided local .retirebridge.json plan file for modeling in Codex. Reads only that file; does not upload it.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "run_model", description: "Run the same deterministic projection, Monte Carlo simulation, lever comparison, or tax comparison used by the website. Requires completed core intake.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, model: { type: "string", enum: ["planned_path", "monte_carlo", "levers", "tax_comparison"] }, run_count: { type: "integer", minimum: 20, maximum: 500 } }, required: ["session_id"], additionalProperties: false } },
  { name: "export_plan", description: "Write the completed plan as a private local .retirebridge.json file and return the website import link. The site asks the user to review before replacing a browser draft.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, directory: { type: "string" } }, required: ["session_id"], additionalProperties: false } },
];

export function handleMessage(message, service) {
  if (!Object.hasOwn(message, "id")) return null;
  const id = message.id;
  if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "retirebridge", version: "0.1.0" } } };
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (!TOOLS.some(tool => tool.name === name)) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    return Promise.resolve().then(() => service[name](message.params?.arguments ?? {}))
      .then(result => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }))
      .catch(error => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "RetireBridge request failed" }] } }));
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

export function runServer(service = createService()) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", async line => {
    let response;
    try { response = await handleMessage(JSON.parse(line), service); }
    catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runServer();
