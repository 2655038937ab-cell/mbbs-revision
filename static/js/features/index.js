// Registry of pluggable feature modules. app.js (or a small launcher) imports
// this to discover available features and mount them. Adding a new feature =
// create a module in ./features and register it here.

import { conceptTest } from "./conceptTest.js";
import { contrast } from "./contrast.js";
import { folders } from "./folders.js";

export const features = [conceptTest, contrast, folders];

export function getFeature(id) {
  return features.find((f) => f.id === id) || null;
}
