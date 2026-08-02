/**
 * Replicates the AfterQuery "Upload Task Submission" flow as observed from the
 * browser network trace. Four sequential calls:
 *
 *   1. POST /api/projects/<proj>/harbor/get-upload-url  { fileName }
 *        -> { uploadUrl, rawStoragePath, contentType }
 *   2. PUT <uploadUrl>  (raw zip bytes, Content-Type from step 1)        [GCS signed URL]
 *   3. POST /api/projects/<proj>/harbor/upload-file  { fileName, rawStoragePath }
 *        -> { fileUrl, fileName, storagePath, warnings }
 *   4. POST /api/projects/<proj>/create-submission
 *        { domain, fileName, fileUrl, language, testStatus:"skipped", version }
 *        -> { submissionId, harborSubmissionId }
 *
 * All API calls carry `Authorization: Bearer <token>`. The PUT in step 2 is a
 * pre-signed GCS URL and must NOT carry the bearer token.
 */

const BASE = process.env.AFTERQUERY_BASE || "https://experts.afterquery.com";
const PROJECT = process.env.AFTERQUERY_PROJECT || "pluto";

export type SubmitStep =
  | "get-upload-url"
  | "upload-raw"
  | "upload-file"
  | "create-submission";

export class SubmitError extends Error {
  step: SubmitStep;
  status?: number;
  detail?: unknown;
  constructor(step: SubmitStep, message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "SubmitError";
    this.step = step;
    this.status = status;
    this.detail = detail;
  }
}

export interface SubmitParams {
  fileName: string;
  fileBytes: Uint8Array;
  domain: string;
  token: string;
  language?: string;
  version?: string;
}

export interface SubmitResult {
  submissionId?: string;
  harborSubmissionId?: string;
  fileUrl?: string;
  storagePath?: string;
  rawStoragePath?: string;
  warnings?: unknown[];
}

function projectPath(suffix: string): string {
  return `${BASE}/api/projects/${PROJECT}/${suffix}`;
}

async function postJson(
  step: SubmitStep,
  suffix: string,
  token: string,
  body: unknown
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(projectPath(suffix), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    throw new SubmitError(step, `Network error calling ${suffix}: ${(e as Error).message}`);
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg =
      json?.error || json?.message || `${suffix} failed with HTTP ${res.status}`;
    throw new SubmitError(step, msg, res.status, json);
  }
  return json;
}

/** Strip a header name, "Bearer" prefix, quotes, and all whitespace from a pasted token. */
export function normalizeToken(token: string): string {
  return token
    .trim()
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, "");
}

export async function runSubmission(params: SubmitParams): Promise<SubmitResult> {
  const token = normalizeToken(params.token);
  if (!token) throw new SubmitError("get-upload-url", "Missing auth token.");
  const { fileName, fileBytes } = params;
  const language = params.language || process.env.DEFAULT_LANGUAGE || "Python";
  const version = params.version || process.env.DEFAULT_VERSION || "Pluto v2";
  const domain = params.domain?.trim();
  if (!domain) throw new SubmitError("create-submission", "Domain is required.");

  // 1. Ask for a signed upload URL.
  const upload = await postJson("get-upload-url", "harbor/get-upload-url", token, {
    fileName,
  });
  const uploadUrl: string | undefined = upload.uploadUrl;
  const rawStoragePath: string | undefined = upload.rawStoragePath;
  const contentType: string = upload.contentType || "application/zip";
  if (!uploadUrl || !rawStoragePath) {
    throw new SubmitError("get-upload-url", "Response missing uploadUrl/rawStoragePath.", undefined, upload);
  }

  // 2. PUT the raw zip bytes to the signed GCS URL (no bearer token).
  {
    let putRes: Response;
    try {
      putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: fileBytes,
        cache: "no-store",
      });
    } catch (e) {
      throw new SubmitError("upload-raw", `Network error during raw upload: ${(e as Error).message}`);
    }
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      throw new SubmitError("upload-raw", `Raw upload failed with HTTP ${putRes.status}`, putRes.status, body);
    }
  }

  // 3. Tell the backend to process the uploaded raw file.
  const processed = await postJson("upload-file", "harbor/upload-file", token, {
    fileName,
    rawStoragePath,
  });
  const fileUrl: string | undefined = processed.fileUrl;
  if (!fileUrl) {
    throw new SubmitError("upload-file", "Response missing fileUrl.", undefined, processed);
  }

  // 4. Create the submission record.
  const created = await postJson("create-submission", "create-submission", token, {
    domain,
    fileName: processed.fileName || fileName,
    fileUrl,
    language,
    testStatus: "skipped",
    version,
  });

  return {
    submissionId: created.submissionId,
    harborSubmissionId: created.harborSubmissionId,
    fileUrl,
    storagePath: processed.storagePath,
    rawStoragePath,
    warnings: processed.warnings ?? [],
  };
}
