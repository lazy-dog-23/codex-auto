import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import { blockersSchema } from "../src/schemas/blockers.schema.js";
import { stateSchema } from "../src/schemas/state.schema.js";
import { tasksSchema } from "../src/schemas/tasks.schema.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(testDir, "fixtures");

function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

function createValidator(schema: unknown): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });

  return ajv.compile(schema as object);
}

describe("schema fixtures", () => {
  it("accepts the sample tasks document", () => {
    const validate = createValidator(tasksSchema);
    const data = readJsonFixture("tasks.sample.json");

    expect(validate(data)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts the sample state document", () => {
    const validate = createValidator(stateSchema);
    const data = readJsonFixture("state.sample.json");

    expect(validate(data)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts the sample blockers document", () => {
    const validate = createValidator(blockersSchema);
    const data = readJsonFixture("blockers.sample.json");

    expect(validate(data)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects a tasks document with a missing required field", () => {
    const validate = createValidator(tasksSchema);
    const data = readJsonFixture<{ tasks: Array<Record<string, unknown>> }>("tasks.sample.json");

    delete data.tasks[0].status;

    expect(validate(data)).toBe(false);
    expect(validate.errors?.some((error) => error.instancePath.includes("/tasks/0"))).toBe(true);
  });
});
