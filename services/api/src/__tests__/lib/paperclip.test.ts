describe("paperclip lib", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
    jest.resetModules();
  });

  function loadPaperclipModule(apiKey = "paperclip-key") {
    jest.doMock("../../lib/config", () => ({
      config: {
        PAPERCLIP_API_KEY: apiKey,
      },
    }));

    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    };

    jest.doMock("../../lib/logger", () => ({ logger }));

    const mod = require("../../lib/paperclip") as typeof import("../../lib/paperclip");
    return { ...mod, logger };
  }

  it("posts task payloads to Paperclip with bearer auth", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "task-1", status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { triggerPaperclipTask, PAPERCLIP_TASKS_URL } = loadPaperclipModule();
    const input = {
      agentId: "agent-1",
      taskType: "digest.generate",
      payload: { userId: "user-123" },
    };

    const result = await triggerPaperclipTask(input);

    expect(fetchMock).toHaveBeenCalledWith(PAPERCLIP_TASKS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer paperclip-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    expect(result).toEqual({ id: "task-1", status: "queued" });
  });

  it("throws a configuration error when the API key is missing", async () => {
    const { triggerPaperclipTask } = loadPaperclipModule("");

    await expect(
      triggerPaperclipTask({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: {},
      }),
    ).rejects.toMatchObject({
      message: "PAPERCLIP_API_KEY is not configured",
      statusCode: 500,
    });
  });

  it("maps upstream failures to a PaperclipError", async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "upstream unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { triggerPaperclipTask } = loadPaperclipModule();

    await expect(
      triggerPaperclipTask({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: {},
      }),
    ).rejects.toMatchObject({
      message: "upstream unavailable",
      statusCode: 502,
      details: { error: "upstream unavailable" },
    });
  });

  it("maps network errors to a PaperclipError", async () => {
    const fetchMock = jest.fn().mockRejectedValueOnce(new Error("socket hang up"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { triggerPaperclipTask } = loadPaperclipModule();

    await expect(
      triggerPaperclipTask({
        agentId: "agent-1",
        taskType: "digest.generate",
        payload: {},
      }),
    ).rejects.toMatchObject({
      message: "Failed to reach Paperclip",
      statusCode: 502,
    });
  });
});
