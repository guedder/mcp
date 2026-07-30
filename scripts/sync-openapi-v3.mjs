import { mkdir, writeFile } from "node:fs/promises";

const SOURCE = process.env.GUEDDER_OPENAPI_URL ?? "https://dev-api.guedder.com/v3/api-docs";
const TARGET = new URL("../src/openapi-v3.json", import.meta.url);
const METHODS = new Set(["get"]);
// Mantém a superfície v3 enxuta e acrescenta somente os GETs legados de gestão
// ainda consolidados. Isso evita entregar o OpenAPI inteiro ao harness.
const MANAGEMENT_LEGACY_PATHS = new Set([
  "/api/v2/compra/evento/{eventoId}/extrato",
  "/api/v1/metrica/{eventoId}/ultimas-vendas",
  "/api/v1/metrica/{eventoId}/resumo-vendas",
  "/api/v1/administrativo/gateway-adquirentes",
]);

function collectRefs(value, refs) {
  if (Array.isArray(value)) return value.forEach((item) => collectRefs(item, refs));
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/")) refs.add(value.$ref);
  Object.values(value).forEach((item) => collectRefs(item, refs));
}

function componentAt(spec, ref) {
  return ref.slice(2).split("/").reduce((value, key) => value?.[key], spec);
}

const response = await fetch(SOURCE, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`OpenAPI indisponível: ${response.status} ${response.statusText}`);
const source = await response.json();
const paths = Object.fromEntries(
  Object.entries(source.paths)
    .filter(([path]) => path.startsWith("/api/v3/") || MANAGEMENT_LEGACY_PATHS.has(path))
    .map(([path, operations]) => [
      path,
      Object.fromEntries(Object.entries(operations).filter(([method]) => METHODS.has(method))),
    ])
    .filter(([, operations]) => Object.keys(operations).length > 0),
);

const refs = new Set();
collectRefs(paths, refs);
for (const ref of refs) collectRefs(componentAt(source, ref), refs);

const components = {};
for (const ref of refs) {
  const [, , section, name] = ref.split("/");
  const value = source.components?.[section]?.[name];
  if (value !== undefined) {
    components[section] ??= {};
    components[section][name] = value;
  }
}
const tagsInUse = new Set(Object.values(paths).flatMap((operations) => Object.values(operations).flatMap((operation) => operation.tags ?? [])));
const filtered = {
  openapi: source.openapi,
  info: source.info,
  servers: source.servers,
  tags: (source.tags ?? []).filter((tag) => tagsInUse.has(tag.name)),
  paths,
  components,
};

await mkdir(new URL("../src/", import.meta.url), { recursive: true });
await writeFile(TARGET, `${JSON.stringify(filtered, null, 2)}\n`);
console.error(`OpenAPI v3 filtrada: ${Object.keys(paths).length} operações GET em ${TARGET.pathname}`);
