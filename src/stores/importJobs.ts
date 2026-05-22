import { create } from "zustand";

export type JobStatus = "processing" | "done" | "error";

export interface ImportJob {
  uid: number;
  filename: string;
  status: JobStatus;
  result?: string;
  error?: string;
}

interface ImportJobsState {
  jobs: ImportJob[];
  addJobs: (jobs: Pick<ImportJob, "uid" | "filename">[]) => void;
  updateJob: (uid: number, patch: Partial<ImportJob>) => void;
  clear: () => void;
}

export const useImportJobsStore = create<ImportJobsState>()((set) => ({
  jobs: [],

  addJobs(newJobs) {
    set((s) => ({
      jobs: [
        ...s.jobs,
        ...newJobs.map((j) => ({ ...j, status: "processing" as const })),
      ],
    }));
  },

  updateJob(uid, patch) {
    set((s) => ({
      jobs: s.jobs.map((j) => (j.uid === uid ? { ...j, ...patch } : j)),
    }));
  },

  clear() {
    set({ jobs: [] });
  },
}));