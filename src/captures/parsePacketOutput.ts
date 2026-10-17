import { z } from "zod";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { packetFieldsSchema } from "../domain/captures/packetCapture.js";

// _index/_score are TShark export metadata, not captured packet fields.
const producerSchema = z.array(
  z.object({ _source: z.object({ layers: packetFieldsSchema }) }),
);
export const parsePacketOutput = (
  text: string,
  fields: readonly string[],
  capturedOutput?: AnalysisCapturedOutput,
) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new AnalysisOutputError(
      "inspect_packet_capture",
      `TShark returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
  }
  const parsed = producerSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AnalysisOutputError(
      "inspect_packet_capture",
      `TShark output schema violation: ${parsed.error.message}`,
      {
        cause: parsed.error,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      },
    );
  }
  const packets = parsed.data.map((packet) => packet._source.layers);
  const selected = new Set(["frame.number", ...fields]);
  let previous = 0n;
  for (const packet of packets) {
    const rawFrame = packet["frame.number"]?.[0];
    if (rawFrame === undefined || !/^\d+$/.test(rawFrame)) {
      throw new AnalysisOutputError(
        "inspect_packet_capture",
        "TShark returned missing or invalid frame number.",
        capturedOutput === undefined ? {} : { capturedOutput },
      );
    }
    const frame = BigInt(rawFrame);
    if (
      frame <= previous ||
      Object.keys(packet).some((name) => !selected.has(name))
    )
      throw new AnalysisOutputError(
        "inspect_packet_capture",
        "TShark returned unordered frames or unselected fields.",
        capturedOutput === undefined ? {} : { capturedOutput },
      );
    previous = frame;
  }
  return packets;
};
