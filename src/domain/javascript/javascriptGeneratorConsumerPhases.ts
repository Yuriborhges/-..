import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
  javaScriptExactResultOperand,
} from "./javascriptAstValues.js";
import {
  syntaxEvaluationCannotThrow,
  syntaxEvaluationAlwaysThrows,
  syntaxBeforeDefiniteThrow,
} from "./javascriptSymbolicControlFlow.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { semanticLiteralProjectionSlot } from "./javascriptSemanticLiteralProjection.js";

interface PatternWaitCache {
  readonly effects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
  readonly iterationUnknown: boolean | undefined;
  readonly ownedResultEscape: t.Node | undefined;
  readonly index: number | null;
  readonly blockedIndex: number | null;
}

interface GeneratorPrefixFacts {
  readonly before: WeakMap<t.Node, number>;
  readonly yielded: readonly t.YieldExpression[];
  readonly cleanup: WeakSet<t.Node>;
  readonly firstPatternWait: WeakMap<t.ArrayPattern, PatternWaitCache>;
}
const prefixes = new WeakMap<t.Node, GeneratorPrefixFacts>();

/** Index only straight-line owned yields; uncertain branches do not prove a resume phase. */
const generatorPrefixes = (
  body: t.Node,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
  state: JavaScriptSemanticAnalysisState,
): GeneratorPrefixFacts => {
  const cached = prefixes.get(body);
  if (cached !== undefined) return cached;
  const before = new WeakMap<t.Node, number>();
  const yielded: t.YieldExpression[] = [];
  const cleanup = new WeakSet<t.Node>();
  let completed = 0;
  const pending: { node: t.Node; exit?: true; cleanup?: boolean }[] = [
    { node: body },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) continue;
    const node = unwrapJavaScriptExpression(entry.node).node;
    if (entry.cleanup) cleanup.add(node);
    if (entry.exit === true) {
      if (t.isYieldExpression(node)) {
        if (node.delegate) completed = -1;
        else if (completed >= 0) {
          yielded.push(node);
          completed += 1;
        }
      }
      continue;
    }
    before.set(node, completed);
    if (t.isFunction(node)) continue;
    if (
      (t.isIfStatement(node) ||
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node) ||
        t.isLoop(node) ||
        t.isSwitchStatement(node) ||
        (t.isTryStatement(node) &&
          !(
            node.handler == null &&
            node.block.body.every((statement) => {
              const expression = t.isExpressionStatement(statement)
                ? statement.expression
                : statement;
              return (
                syntaxEvaluationCannotThrow(expression) ||
                (t.isYieldExpression(expression) &&
                  !expression.delegate &&
                  (expression.argument == null ||
                    syntaxEvaluationCannotThrow(expression.argument) ||
                    undefinedPatternValue(
                      { known: true, node: expression.argument },
                      state,
                    )))
              );
            })
          ))) &&
      maySuspend(node)
    )
      completed = -1;
    if (t.isYieldExpression(node)) pending.push({ node, exit: true });
    const children = ordered(node);
    for (const child of children.toReversed())
      pending.push({
        node: child,
        cleanup:
          entry.cleanup || (t.isTryStatement(node) && child === node.finalizer),
      });
  }
  const facts = {
    before,
    yielded,
    cleanup,
    firstPatternWait: new WeakMap<t.ArrayPattern, PatternWaitCache>(),
  };
  prefixes.set(body, facts);
  return facts;
};

type PatternValue = {
  readonly known: boolean;
  readonly node?: t.Node;
  readonly restStartIndex?: number;
  readonly ownedResultEscape?: t.Node;
};

/** Normal result selection is separate from whether its evaluation can finish. */
const patternValueNode = (raw: t.Node): t.Node => {
  let node = unwrapJavaScriptExpression(raw).node;
  for (;;) {
    const result = javaScriptExactResultOperand(node);
    if (result === undefined) return node;
    node = unwrapJavaScriptExpression(result).node;
  }
};

const undefinedPatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const argument =
    value.node === undefined ? undefined : patternValueNode(value.node);
  return (
    value.known &&
    (argument === undefined ||
      (t.isIdentifier(argument, { name: "undefined" }) &&
        resolveSemanticBindingState(state, argument, "undefined") ===
          undefined) ||
      (t.isUnaryExpression(argument, { operator: "void" }) &&
        readExactJavaScriptLiteral(argument.argument).found))
  );
};

/** Both object coercion and iterator acquisition reject nullish slot values. */
const nullishPatternValue = (
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  undefinedPatternValue(value, state) ||
  (value.known &&
    value.node !== undefined &&
    t.isNullLiteral(patternValueNode(value.node)));

/** Use the same mutation and iterator proof as ordinary literal projections. */
const patternPropertyValue = (
  value: PatternValue,
  key: string | number,
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
): PatternValue => {
  if (!value.known || value.node === undefined) return { known: false };
  const node = patternValueNode(value.node);
  if (value.restStartIndex !== undefined && typeof key !== "number")
    return { known: false };
  const selected = semanticLiteralProjectionSlot(
    node,
    typeof key === "number" ? key + (value.restStartIndex ?? 0) : key,
    capture,
    state,
    value.ownedResultEscape === undefined
      ? undefined
      : { ownedResultEscape: value.ownedResultEscape },
  );
  if (selected.kind === "value")
    return {
      known: true,
      node: selected.node,
      ...(value.ownedResultEscape === undefined
        ? {}
        : { ownedResultEscape: value.ownedResultEscape }),
    };
  if (selected.kind === "undefined") return { known: true };
  return { known: false };
};

/** A rest copy owns a fresh suffix array; retain indices without synthesizing AST. */
const patternArrayRest = (
  value: PatternValue,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): PatternValue => {
  const node =
    value.node === undefined ? undefined : patternValueNode(value.node);
  return value.known &&
    t.isArrayExpression(node) &&
    state.arrayIterationUnknown !== true &&
    !node.elements.some((item) => t.isSpreadElement(item))
    ? {
        known: true,
        node,
        restStartIndex: (value.restStartIndex ?? 0) + index,
        ...(value.ownedResultEscape === undefined
          ? {}
          : { ownedResultEscape: value.ownedResultEscape }),
      }
    : { known: false };
};

type PatternCompletion =
  | "completed"
  | "suspended"
  | "blocked"
  | "suspended-blocked";
const patternSuspended = (phase: PatternCompletion): boolean =>
  phase === "suspended" || phase === "suspended-blocked";
const patternBlocked = (phase: PatternCompletion): boolean =>
  phase === "blocked" || phase === "suspended-blocked";
const combinePatternCompletion = (
  before: PatternCompletion,
  after: PatternCompletion,
): PatternCompletion => {
  if (patternBlocked(before)) return before;
  return patternSuspended(before) || patternSuspended(after)
    ? patternBlocked(after)
      ? "suspended-blocked"
      : "suspended"
    : after;
};
const patternExpressionCompletion = (
  node: t.Node,
  suspended: (node: t.Node) => boolean,
): PatternCompletion =>
  syntaxEvaluationAlwaysThrows(node)
    ? syntaxBeforeDefiniteThrow(node).some(suspended)
      ? "suspended-blocked"
      : "blocked"
    : suspended(node)
      ? "suspended"
      : "completed";

/** Work completed inside a consumed slot precedes the next generator resume. */
const patternCompletedSuspension = (
  pattern: t.Node,
  value: PatternValue,
  state: JavaScriptSemanticAnalysisState,
  suspended: (node: t.Node) => boolean,
  depth = 0,
  target?: t.Node,
  targetPath?: ReadonlySet<t.Node>,
): PatternCompletion => {
  if (depth >= 128) return "blocked";
  if (pattern === target) return "completed";
  if (t.isAssignmentPattern(pattern)) {
    const selectsDefault = undefinedPatternValue(value, state);
    const prefix = selectsDefault
      ? patternExpressionCompletion(pattern.right, suspended)
      : "completed";
    if (patternBlocked(prefix)) return prefix;
    return combinePatternCompletion(
      prefix,
      patternCompletedSuspension(
        pattern.left,
        selectsDefault ? { known: true, node: pattern.right } : value,
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
      ),
    );
  }
  let phase: PatternCompletion = "completed";
  if (t.isObjectPattern(pattern)) {
    // RequireObjectCoercible precedes property keys and rest operations.
    // A definite failure also blocks waits in later consumed slots.
    if (nullishPatternValue(value, state)) return "blocked";
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) continue;
      if (property.computed)
        phase = combinePatternCompletion(
          phase,
          patternExpressionCompletion(property.key, suspended),
        );
      if (patternBlocked(phase)) return phase;
      const key = semanticStaticPropertyKey(property.key, property.computed);
      const completion = patternCompletedSuspension(
        property.value,
        key === null
          ? { known: false }
          : patternPropertyValue(value, key, state, pattern),
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
      );
      phase = combinePatternCompletion(phase, completion);
      if (patternBlocked(phase)) return phase;
      if (targetPath?.has(property)) return phase;
    }
  }
  if (t.isArrayPattern(pattern)) {
    // GetIterator runs even for an empty pattern, before later slots/defaults.
    if (nullishPatternValue(value, state)) return "blocked";
    for (const [index, element] of pattern.elements.entries()) {
      if (element === null) continue;
      const completion = patternCompletedSuspension(
        t.isRestElement(element) ? element.argument : element,
        t.isRestElement(element)
          ? patternArrayRest(value, index, state)
          : patternPropertyValue(value, index, state, pattern),
        state,
        suspended,
        depth + 1,
        target,
        targetPath,
      );
      phase = combinePatternCompletion(phase, completion);
      if (patternBlocked(phase)) return phase;
      if (targetPath?.has(element)) return phase;
    }
  }
  return phase;
};

/** Selected defaults and keys before a particular destructuring write share slot semantics. */
export const semanticPatternSuspendsBeforeTarget = (
  pattern: t.Node,
  value: t.Node,
  target: t.Node,
  state: JavaScriptSemanticAnalysisState,
  completedSuspension: (node: t.Node) => boolean,
): boolean => {
  const path = new Set<t.Node>();
  let current: t.Node | undefined = target;
  while (current !== undefined) {
    path.add(current);
    if (current === pattern)
      return (
        patternCompletedSuspension(
          pattern,
          { known: true, node: value },
          state,
          completedSuspension,
          0,
          target,
          path,
        ) === "suspended"
      );
    current = state.parentsByNode.get(current);
  }
  return false;
};

/** Only completed work in an earlier consumed slot can delay the next iterator step. */
export const semanticPatternSuspendsBeforeGeneratorRead = ({
  read,
  body,
  pattern,
  state,
  ordered,
  maySuspend,
  completedSuspension,
  ownedResultEscape,
}: {
  readonly read: t.Node;
  readonly body: t.Node;
  readonly pattern: t.ArrayPattern;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly ordered: (node: t.Node) => readonly t.Node[];
  readonly maySuspend: (node: t.Node) => boolean;
  readonly completedSuspension: (node: t.Node) => boolean;
  readonly ownedResultEscape?: t.Node;
}): boolean => {
  const facts = generatorPrefixes(body, ordered, maySuspend, state);
  const count = facts.before.get(unwrapJavaScriptExpression(read).node);
  if (count === undefined || count < 0) return false;
  const cleanup = facts.cleanup.has(read);
  // A finite pattern closes its iterator after its last slot, not another next().
  if (
    !cleanup &&
    count >= pattern.elements.length &&
    !pattern.elements.some((element) => t.isRestElement(element))
  )
    return false;
  const waited = (index: number | null, blockedIndex: number | null): boolean =>
    index !== null &&
    index < count &&
    (cleanup || blockedIndex === null || blockedIndex >= count);
  const cached = facts.firstPatternWait.get(pattern);
  if (
    cached !== undefined &&
    cached.effects === state.literalMemberEffects &&
    cached.iterationUnknown === state.arrayIterationUnknown &&
    cached.ownedResultEscape === ownedResultEscape
  )
    return waited(cached.index, cached.blockedIndex);
  const cache = (index: number | null, blockedIndex: number | null): void => {
    facts.firstPatternWait.set(pattern, {
      effects: state.literalMemberEffects,
      iterationUnknown: state.arrayIterationUnknown,
      ownedResultEscape,
      index,
      blockedIndex,
    });
  };
  let firstWait: number | null = null;
  let blockedAt: number | null = null;
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const element = pattern.elements[index];
    if (t.isRestElement(element)) break;
    if (element == null) continue;
    const yielded = facts.yielded[index];
    if (yielded === undefined) break;
    const completion = patternCompletedSuspension(
      element,
      {
        known: true,
        ...(yielded.argument == null ? {} : { node: yielded.argument }),
        ...(ownedResultEscape === undefined ? {} : { ownedResultEscape }),
      },
      state,
      completedSuspension,
    );
    if (patternSuspended(completion)) firstWait ??= index;
    if (patternBlocked(completion)) {
      blockedAt = index;
      break;
    }
  }
  cache(firstWait, blockedAt);
  return waited(firstWait, blockedAt);
};

/** A consumer phase can defer a body read only after an owned yield was reached. */
export const semanticGeneratorReadAfterYield = (
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): boolean =>
  (generatorPrefixes(body, ordered, maySuspend, state).before.get(read) ?? -1) >
  0;

/** IteratorClose enters finally without requesting another ordinary body step. */
export const semanticGeneratorReadInCleanup = (
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ordered: (node: t.Node) => readonly t.Node[],
  maySuspend: (node: t.Node) => boolean,
): boolean =>
  generatorPrefixes(body, ordered, maySuspend, state).cleanup.has(read);
