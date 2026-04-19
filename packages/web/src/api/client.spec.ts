import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAndExecuteOperation,
  fetchAutonomyStatus,
  fetchRoutePreview,
  fetchZoraSignalCandidates,
  requestSupportFromZoraSignal,
} from "./client";

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("automation api client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("builds the signal query with optional filters", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        candidates: [{ coinAddress: "0x1234567890abcdef1234567890abcdef12345678" }],
      }),
    );

    await fetchZoraSignalCandidates({
      mode: "watchlist_top",
      listName: "alpha",
      limit: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4020/operations/zora-signals?mode=watchlist_top&listName=alpha&limit=3",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("posts signal support requests with the selected fleet cluster", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        operation: {
          id: 17,
          type: "SUPPORT_COIN",
          clusterId: 5,
          status: "pending",
          requestedBy: "web-operator",
          approvedBy: null,
          payloadJson: "{}",
          resultJson: null,
          errorMessage: null,
          createdAt: "2026-04-18T12:00:00.000Z",
          updatedAt: "2026-04-18T12:00:00.000Z",
        },
      }),
    );

    await requestSupportFromZoraSignal({
      clusterId: 5,
      mode: "top_momentum",
      minMomentum: 60,
      totalAmountWei: "1000",
      slippageBps: 125,
      requestedBy: "web-operator",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4020/operations/support-from-zora-signal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clusterId: 5,
          mode: "top_momentum",
          minMomentum: 60,
          totalAmountWei: "1000",
          slippageBps: 125,
          requestedBy: "web-operator",
        }),
      }),
    );
  });

  it("posts route preview requests", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        route: {
          path: [
            "0x4200000000000000000000000000000000000006",
            "0x1234567890abcdef1234567890abcdef12345678",
          ],
          hops: 1,
        },
      }),
    );

    const route = await fetchRoutePreview({
      fromToken: "0x4200000000000000000000000000000000000006",
      toToken: "0x1234567890abcdef1234567890abcdef12345678",
      maxHops: 2,
    });

    expect(route).toEqual({
      path: [
        "0x4200000000000000000000000000000000000006",
        "0x1234567890abcdef1234567890abcdef12345678",
      ],
      hops: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4020/operations/route-preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fromToken: "0x4200000000000000000000000000000000000006",
          toToken: "0x1234567890abcdef1234567890abcdef12345678",
          maxHops: 2,
        }),
      }),
    );
  });

  it("posts approve and execute requests with the approver tag", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        operation: {
          id: 22,
          type: "SUPPORT_COIN",
          clusterId: 3,
          status: "approved",
          requestedBy: "web-operator",
          approvedBy: "web-operator",
          payloadJson: "{}",
          resultJson: null,
          errorMessage: null,
          createdAt: "2026-04-18T12:00:00.000Z",
          updatedAt: "2026-04-18T12:00:01.000Z",
        },
      }),
    );

    await approveAndExecuteOperation(22, "web-operator");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4020/operations/22/approve-execute",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ approvedBy: "web-operator" }),
      }),
    );
  });

  it("returns the full autonomy status payload", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        running: true,
        intervalSec: 90,
        isTicking: false,
        config: {
          enabled: true,
          autoStart: false,
          intervalSec: 90,
          clusterIds: [1, 2],
          signalMode: "watchlist_top",
          watchlistName: "default",
          minMomentum: null,
          totalAmountWei: "1000",
          slippageBps: 100,
          strategyMode: null,
          requestedBy: "autonomy-worker",
          createRequests: true,
          autoApprovePending: true,
          pumpThreshold: 3,
          dipThreshold: 0.5,
          ownDiscountEnabled: true,
        },
        lastTick: null,
      }),
    );

    const status = await fetchAutonomyStatus();

    expect(status.config.clusterIds).toEqual([1, 2]);
    expect(status.config.autoApprovePending).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4020/autonomy/status",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
  });
});
