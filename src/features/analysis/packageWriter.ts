import { invoke } from "@tauri-apps/api/core";

export type PackageFile = { name: string; content: string };
export type PackageReceipt = { directory: string; status: "complete"; fileCount: number; totalBytes: number };

export async function saveAnalysisPackage(directory: string, files: PackageFile[]): Promise<PackageReceipt> {
  return invoke<PackageReceipt>("save_analysis_package", { directory, files });
}
