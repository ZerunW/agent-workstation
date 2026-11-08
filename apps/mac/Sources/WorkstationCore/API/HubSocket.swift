import Foundation

public enum SocketState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case waiting(retryIn: TimeInterval)
}

/// Abstraction over the hub's event stream so view models can be driven by a fake in tests.
public protocol HubEventSource: AnyObject {
    var onEvent: ((ServerEvent) -> Void)? { get set }
    var onState: ((SocketState) -> Void)? { get set }
    func start()
    func stop()
    func subscribe(sessionId: String, lastSeq: Int)
    func unsubscribe(sessionId: String)
    func send(_ event: ClientEvent)
}

/// `URLSessionWebSocketTask` client: `hello` → `welcome`, re-subscribes after reconnect,
/// exponential backoff, 25 s keep-alive pings. Callbacks are delivered on the main queue.
public final class HubSocket: NSObject, HubEventSource, URLSessionWebSocketDelegate, @unchecked Sendable {
    public var onEvent: ((ServerEvent) -> Void)?
    public var onState: ((SocketState) -> Void)?

    private let url: URL
    private let user: String
    private let queue = DispatchQueue(label: "io.github.agentworkstation.socket")
    private var urlSession: URLSession!
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    private var attempt = 0
    private var running = false
    private var subscriptions: [String: Int] = [:]
    private var pingTimer: DispatchSourceTimer?
    private let backoff = Backoff(base: 1, factor: 2, maximum: 30)

    public init(baseURL: URL, user: String) {
        self.url = Routes.webSocketURL(base: baseURL, user: user)
        self.user = user
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        urlSession = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    public func start() {
        queue.async {
            guard !self.running else { return }
            self.running = true
            self.connect()
        }
    }

    public func stop() {
        queue.async {
            self.running = false
            self.generation += 1
            self.pingTimer?.cancel(); self.pingTimer = nil
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.emitState(.disconnected)
        }
    }

    public func subscribe(sessionId: String, lastSeq: Int) {
        queue.async {
            self.subscriptions[sessionId] = lastSeq
            self.sendNow(.subscribe(sessionId: sessionId, lastSeq: lastSeq))
        }
    }

    public func unsubscribe(sessionId: String) {
        queue.async {
            self.subscriptions.removeValue(forKey: sessionId)
            self.sendNow(.unsubscribe(sessionId: sessionId))
        }
    }

    public func send(_ event: ClientEvent) { queue.async { self.sendNow(event) } }

    // MARK: internals (on `queue`)

    private func connect() {
        guard running else { return }
        generation += 1
        let gen = generation
        emitState(.connecting)
        var req = URLRequest(url: url)
        req.setValue(user, forHTTPHeaderField: WorkstationProtocol.userHeader)
        let t = urlSession.webSocketTask(with: req)
        t.maximumMessageSize = 16 * 1024 * 1024
        task = t
        t.resume()
        receive(on: t, gen: gen)
    }

    private func sendNow(_ event: ClientEvent) {
        guard let task else { return }
        task.send(.string(event.text)) { _ in }
    }

    private func receive(on t: URLSessionWebSocketTask, gen: Int) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard gen == self.generation else { return }
                switch result {
                case .success(let msg):
                    let data: Data
                    switch msg {
                    case .string(let s): data = Data(s.utf8)
                    case .data(let d): data = d
                    @unknown default: data = Data()
                    }
                    if let ev = ServerEvent.decode(data) {
                        if case .welcome = ev { self.attempt = 0 }
                        DispatchQueue.main.async { self.onEvent?(ev) }
                    }
                    self.receive(on: t, gen: gen)
                case .failure:
                    self.scheduleReconnect(gen: gen)
                }
            }
        }
    }

    private func scheduleReconnect(gen: Int) {
        guard running, gen == generation else { return }
        pingTimer?.cancel(); pingTimer = nil
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        let delay = backoff.delay(attempt: attempt, jitter: Double.random(in: 0...0.4))
        attempt += 1
        emitState(.waiting(retryIn: delay))
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.running, gen == self.generation else { return }
            self.connect()
        }
    }

    private func didOpen(task t: URLSessionWebSocketTask) {
        guard t === task else { return }
        emitState(.connected)
        sendNow(.hello(user: user, protocolVersion: WorkstationProtocol.protocolVersion))
        for (id, seq) in subscriptions { sendNow(.subscribe(sessionId: id, lastSeq: seq)) }
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 25, repeating: 25)
        timer.setEventHandler { [weak self] in self?.sendNow(.ping) }
        timer.resume()
        pingTimer = timer
    }

    private func emitState(_ s: SocketState) {
        DispatchQueue.main.async { self.onState?(s) }
    }

    // MARK: URLSessionWebSocketDelegate

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        queue.async { self.didOpen(task: webSocketTask) }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        queue.async { if webSocketTask === self.task { self.scheduleReconnect(gen: self.generation) } }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        queue.async { if task === self.task { self.scheduleReconnect(gen: self.generation) } }
    }
}
