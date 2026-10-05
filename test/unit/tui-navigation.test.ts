import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

// Exercise the actual declarative commands, without mocking the terminal
// renderer. Real TUI conformance is checked separately through tmux.
const source = ts.createSourceFile(
  "tui.tsx",
  readFileSync(new URL("../../src/tui.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function command(id: string) {
  let found: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const matches = node.properties.some((p) =>
        ts.isPropertyAssignment(p) && p.name.getText(source) === "id" &&
        ts.isStringLiteral(p.initializer) && p.initializer.text === id,
      )
      if (matches) found = node
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`missing TUI command ${id}`)
  const value = (name: string, context: Record<string, unknown> = {}) => {
    const property = found!.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === name)
    if (!property || !ts.isPropertyAssignment(property)) throw new Error(`missing ${id}.${name}`)
    // Only trusted repository command expressions are evaluated; no external
    // input enters this unit-level declaration check.
    return runInNewContext(`(${property.initializer.getText(source)})`, context)
  }
  return { value }
}

describe("dashboard navigation declarations", () => {
  it("c switches inbox to cron without calling either inbox clear action", () => {
    const current = { view: "inbox" }
    const clearSelected = vi.fn()
    const clearAllInbox = vi.fn()
    const setJobSel = vi.fn()
    const context = {
      view: () => current.view,
      setView: (view: string) => { current.view = view },
      setJobSel,
      clearSelected,
      clearAllInbox,
    }
    const cron = command("jazz.cron")
    expect(cron.value("bind")).toBe("c")
    expect(cron.value("enabled", context)()).toBe(true)
    cron.value("run", context)()
    expect(current.view).toBe("cron")
    expect(setJobSel).toHaveBeenCalledWith(0)
    expect(clearSelected).not.toHaveBeenCalled()
    expect(clearAllInbox).not.toHaveBeenCalled()
  })

  it("inbox clearing uses x / X and stays scoped to the inbox", () => {
    for (const [id, bind] of [["jazz.clear", "x"], ["jazz.clearall", "shift+x"]]) {
      const clear = command(id!)
      expect(clear.value("bind")).toBe(bind)
      expect(clear.value("enabled", { view: () => "inbox" })()).toBe(true)
      for (const view of ["dash", "cron", "kanban", "detail", "msg"]) {
        expect(clear.value("enabled", { view: () => view })()).toBe(false)
      }
    }
  })
})
