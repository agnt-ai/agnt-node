import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TasksResource } from '../../resources/TasksResource.js';
import { makeMockHttp } from '../helpers.js';

let http: ReturnType<typeof makeMockHttp>;
let tasks: TasksResource;

beforeEach(() => {
  http = makeMockHttp();
  tasks = new TasksResource(http);
});

describe('TasksResource', () => {
  describe('list()', () => {
    it('calls GET /tasks and maps items from r.tasks', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 20, total: 1, tasks: [{ id: 't1' }] });
      const result = await tasks.list();
      expect(http.get).toHaveBeenCalledWith('/tasks', undefined);
      expect(result.items).toEqual([{ id: 't1' }]);
    });

    it('passes params to GET', async () => {
      vi.mocked(http.get).mockResolvedValue({ ok: true, page: 1, perPage: 10, total: 0, tasks: [] });
      await tasks.list({ status: 'open' });
      expect(http.get).toHaveBeenCalledWith('/tasks', { status: 'open' });
    });
  });

  describe('create()', () => {
    it('calls POST /tasks and returns r.task', async () => {
      const task = { id: 't1', title: 'Book a flight' };
      vi.mocked(http.post).mockResolvedValue({ task });
      const result = await tasks.create({ title: 'Book a flight', assistant: 'travel@agnt.ai' });
      expect(http.post).toHaveBeenCalledWith('/tasks', { title: 'Book a flight', assistant: 'travel@agnt.ai' });
      expect(result).toEqual(task);
    });
  });

  describe('get()', () => {
    it('calls GET /tasks/:id and returns r.task', async () => {
      const task = { id: 't1' };
      vi.mocked(http.get).mockResolvedValue({ task });
      const result = await tasks.get('t1');
      expect(http.get).toHaveBeenCalledWith('/tasks/t1');
      expect(result).toEqual(task);
    });
  });

  describe('update()', () => {
    it('calls PUT /tasks/:id and returns r.task', async () => {
      const task = { id: 't1', status: 'done' };
      vi.mocked(http.put).mockResolvedValue({ task });
      const result = await tasks.update('t1', { status: 'done' });
      expect(http.put).toHaveBeenCalledWith('/tasks/t1', { status: 'done' });
      expect(result).toEqual(task);
    });
  });

  describe('delete()', () => {
    it('calls DELETE /tasks/:id', async () => {
      vi.mocked(http.delete).mockResolvedValue({});
      await tasks.delete('t1');
      expect(http.delete).toHaveBeenCalledWith('/tasks/t1');
    });
  });

  describe('process()', () => {
    it('calls POST /tasks/:id/process with empty body by default', async () => {
      vi.mocked(http.post).mockResolvedValue({ process: { taskId: 't1', executionId: 'e1' } });
      const result = await tasks.process('t1');
      expect(http.post).toHaveBeenCalledWith('/tasks/t1/process', {});
      expect(result).toEqual({ taskId: 't1', executionId: 'e1' });
    });

    it('passes message and files when provided', async () => {
      vi.mocked(http.post).mockResolvedValue({ process: { taskId: 't1', executionId: 'e2' } });
      await tasks.process('t1', { message: 'Start now' });
      expect(http.post).toHaveBeenCalledWith('/tasks/t1/process', { message: 'Start now' });
    });
  });

  describe('stop()', () => {
    it('calls POST /tasks/:id/stop and returns r.task', async () => {
      const task = { id: 't1', status: 'stopped' };
      vi.mocked(http.post).mockResolvedValue({ task });
      const result = await tasks.stop('t1');
      expect(http.post).toHaveBeenCalledWith('/tasks/t1/stop');
      expect(result).toEqual(task);
    });
  });

  describe('feedback()', () => {
    it('calls POST /tasks/:id/feedback with status', async () => {
      vi.mocked(http.post).mockResolvedValue({});
      await tasks.feedback('t1', 'like');
      expect(http.post).toHaveBeenCalledWith('/tasks/t1/feedback', { status: 'like' });
    });

    it('accepts null status', async () => {
      vi.mocked(http.post).mockResolvedValue({});
      await tasks.feedback('t1', null);
      expect(http.post).toHaveBeenCalledWith('/tasks/t1/feedback', { status: null });
    });
  });

  describe('updateAssignees()', () => {
    it('calls PUT /tasks/:id/assignees with emails array', async () => {
      const task = { id: 't1' };
      vi.mocked(http.put).mockResolvedValue({ task });
      const result = await tasks.updateAssignees('t1', ['alice@example.com', 'bob@example.com']);
      expect(http.put).toHaveBeenCalledWith('/tasks/t1/assignees', { emails: ['alice@example.com', 'bob@example.com'] });
      expect(result).toEqual(task);
    });
  });
});
