import type { HttpClient } from '../HttpClient.js';
import type {
  Task, CreateTaskBody, UpdateTaskBody, ListTasksParams, PagedResponse
} from '../types.js';

export class TasksResource {
  constructor(private http: HttpClient) {}

  async list(params?: ListTasksParams): Promise<PagedResponse<Task>> {
    const r = await this.http.get<any>('/tasks', params as any);
    return { ok: r.ok, page: r.page, perPage: r.perPage, total: r.total, items: r.tasks };
  }

  async create(body: CreateTaskBody): Promise<Task> {
    const r = await this.http.post<any>('/tasks', body);
    return r.task;
  }

  async get(taskId: string): Promise<Task> {
    const r = await this.http.get<any>(`/tasks/${taskId}`);
    return r.task;
  }

  async update(taskId: string, body: UpdateTaskBody): Promise<Task> {
    const r = await this.http.put<any>(`/tasks/${taskId}`, body);
    return r.task;
  }

  async delete(taskId: string): Promise<void> {
    await this.http.delete(`/tasks/${taskId}`);
  }

  async process(taskId: string, body?: { message?: string; files?: any[] }): Promise<{ taskId: string; executionId: string }> {
    const r = await this.http.post<any>(`/tasks/${taskId}/process`, body ?? {});
    return r.process;
  }

  async stop(taskId: string): Promise<Task> {
    const r = await this.http.post<any>(`/tasks/${taskId}/stop`);
    return r.task;
  }

  async feedback(taskId: string, status: 'like' | 'dislike' | null): Promise<void> {
    await this.http.post(`/tasks/${taskId}/feedback`, { status });
  }

  async updateAssignees(taskId: string, emails: string[]): Promise<Task> {
    const r = await this.http.put<any>(`/tasks/${taskId}/assignees`, { emails });
    return r.task;
  }
}
