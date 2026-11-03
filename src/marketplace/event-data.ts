// `events_raw.data_json` holds the `data` of the NEP-297 log, which is an ARRAY with one object (`[{"epoch": 3, …}]`) on a real chain; tests and older code stored the bare object. A field is
// read from either shape. Found by the near-sandbox test of BE-055: with `$.field` alone, a real event gave NULL.
/** SQL expression for the field `key` of the event in the column `data_json` (a name of a field, not user input). */
export const eventField = (key: string, column = "data_json"): string => {
  if (!/^[a-z_]+$/.test(key)) throw new Error(`campo de evento tidak sah: ${key}`);
  return `COALESCE(json_extract(${column}, '$[0].${key}'), json_extract(${column}, '$.${key}'))`;
};

/** The object of the event from `data_json`, whichever shape it has. */
export const eventData = <T = Record<string, unknown>>(dataJson: string): T => {
  const value: unknown = JSON.parse(dataJson);
  return (Array.isArray(value) ? value[0] : value) as T;
};
