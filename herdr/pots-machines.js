import { machines } from "herdr";

export const machineLabel = machine => machine ?? "This computer";
export const isMachineReady = name => machines().some(machine => machine.name === name && machine.layout === "ready");
