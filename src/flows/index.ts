import type { RegisteredFlow, FlowMeta } from '../automation/types.js';
import { demoFlow } from './demo.js';
import { capcutSigninFlow } from './capcut-signin.js';

/**
 * Flow registry. Adding a new automation = write a file in this folder exporting
 * a RegisteredFlow, then register it here with one line. The `name` in each
 * flow's meta is the stable key ProjectRecord.flowName points at.
 */
export const FLOWS: Record<string, RegisteredFlow> = {
  [demoFlow.meta.name]: demoFlow,
  [capcutSigninFlow.meta.name]: capcutSigninFlow,
};

/** Metadata list for the Project tab's flow dropdown. */
export function flowMetas(): FlowMeta[] {
  return Object.values(FLOWS).map((f) => f.meta);
}

/** Look up a registered flow by name, or undefined if unknown. */
export function getFlow(name: string): RegisteredFlow | undefined {
  return FLOWS[name];
}
