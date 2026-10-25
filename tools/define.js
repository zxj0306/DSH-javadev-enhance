/**
 * Minimal tool definition helper (JSON value + render) for this plugin.
 * Keeps tool results model-facing text only and avoids depending on the
 * host's internal defineTool helper.
 */

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} spec.parameters
 * @param {(args:any, exec:any) => Promise<any>} spec.execute
 * @param {(args:any, value:any) => string} [spec.render]
 * @returns {object} ToolDefinition
 */
export function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: spec.render ? spec.render(args, value) : String(value) }]
    },
    execute: spec.execute
  };
}

/**
 * Convert a plugin-level error value into a uniform shape.
 * @param {string} message
 * @param {string} [code]
 */
export function toolError(message, code = 'JAVA_DEV_ERROR') {
  return { ok: false, error: { code, message } };
}
