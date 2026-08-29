/**
 * Premium Knowledge Types
 * Core types and enums for Profile Intelligence features
 */

export enum DocType {
  RESUME = 'resume',
  JD = 'jd',
  COMPANY = 'company',
}

export interface DocumentIngestResult {
  success: boolean;
  error?: string;
  documentId?: string;
}

export interface ProfileStatus {
  hasResume: boolean;
  hasJD: boolean;
  hasCompany: boolean;
  lastResumeUpdate?: string;
  lastJDUpdate?: string;
}

export interface ProfileData {
  resume?: any;
  jd?: any;
  company?: any;
}

export interface DocumentMetadata {
  type: DocType;
  uploadedAt: string;
  fileName: string;
}
