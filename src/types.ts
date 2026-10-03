export type SessionStatus = 'active' | 'expired' | 'deleting' | 'deleted' | 'failed';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type JobKind = 'generation' | 'edit';
export type AssetKind = 'input' | 'output';

export interface ImageSession {
  id: string;
  conversation_id: string;
  conversation_url: string;
  project_id: string | null;
  project_name: string | null;
  status: SessionStatus;
  ttl_seconds: number;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  expires_at: number;
  metadata_json: string | null;
}

export interface ImageJob {
  id: string;
  session_id: string | null;
  kind: JobKind;
  prompt: string;
  request_json: string;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  error_message: string | null;
}

export interface GeneratedAsset {
  mimeType: string;
  base64: string;
  width: number;
  height: number;
  filePath?: string;
}

export interface DriverResult {
  conversationId: string;
  conversationUrl: string;
  assets: GeneratedAsset[];
}
