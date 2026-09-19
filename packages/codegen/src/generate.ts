import { generateCSharp } from "./csharp"
import { generateGDScript } from "./gdscript"
import { generateJson } from "./json"
import type { CodegenModel } from "./model"

export type Language = "csharp" | "gdscript" | "json"

export interface CodegenOptions {
  readonly lang: Language
  /** C#: the namespace (default `Bungohan.Generated`). */
  readonly namespace?: string
  /** GDScript: where the addon lives (default `res://addons/bungohan`). */
  readonly addon?: string
  /** A short, machine-independent note of what was generated from. */
  readonly source?: string
}

/**
 * The files for one language: relative path → content. Deterministic: the
 * same model and options always give byte-identical files.
 */
export function generate(
  model: CodegenModel,
  options: CodegenOptions,
): Map<string, string> {
  const source = options.source ?? "a Bungohan contract and state"
  switch (options.lang) {
    case "csharp":
      return generateCSharp(model, {
        namespace: options.namespace ?? "Bungohan.Generated",
        source,
      })
    case "gdscript":
      return generateGDScript(model, {
        addon: (options.addon ?? "res://addons/bungohan").replace(/\/$/, ""),
        source,
      })
    case "json":
      return generateJson(model)
  }
}
