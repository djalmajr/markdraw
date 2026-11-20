use super::*;
use crate::mcp_server::testkit::Fake;
use std::time::Instant;

const SHORT: Duration = Duration::from_millis(150);

fn setup(timeout: Duration, queue: usize) -> (Arc<Registry>, Arc<Fake>) {
    let registry = Arc::new(Registry {
        approvals: Gate::with_limits(timeout, queue),
        ..Registry::default()
    });
    let fake = Fake::attach(&registry);
    (registry, fake)
}
fn ask(registry: &Arc<Registry>) -> tokio::task::JoinHandle<Decision> {
    let registry = registry.clone();
    tokio::spawn(async move {
        registry
            .approvals
            .request(
                &registry.window,
                "write_file",
                "notes/a.md",
                "Replace 3 lines",
            )
            .await
    })
}
async fn requests(fake: &Fake, count: usize) -> Vec<Value> {
    loop {
        let all = fake.named("mcp-approval-request");
        if all.len() >= count {
            return all;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
fn answer(registry: &Registry, id: &Value, approved: bool) -> Result<(), &'static str> {
    registry.approvals.respond(
        &registry.window,
        true,
        json!({"id": id, "approved": approved}),
    )
}

#[test]
fn the_contract_limits() {
    assert_eq!(APPROVAL_TIMEOUT, Duration::from_secs(120));
    assert_eq!(MAX_QUEUE, 4);
    let gate = Gate::default();
    assert_eq!((gate.timeout, gate.queue), (APPROVAL_TIMEOUT, MAX_QUEUE));
}

#[tokio::test]
async fn an_approval_names_the_operation_and_covers_one_execution() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let call = ask(&registry);
    let request = requests(&fake, 1).await.remove(0);
    assert_eq!(
        request
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        ["id", "operation", "summary", "target"]
            .map(String::from)
            .into()
    );
    assert_eq!(request["operation"], "write_file");
    assert_eq!(request["target"], "notes/a.md");
    assert_eq!(request["summary"], "Replace 3 lines");
    assert_eq!(request["id"].as_str().unwrap().len(), 64);
    assert!(answer(&registry, &request["id"], true).is_ok());
    assert_eq!(call.await.unwrap(), Decision::Approved);
    // The approval is spent: the same id cannot approve a second execution.
    assert!(answer(&registry, &request["id"], true).is_err());
    let next = ask(&registry);
    let second = requests(&fake, 2).await.remove(1);
    assert_ne!(second["id"], request["id"]);
    assert!(answer(&registry, &second["id"], false).is_ok());
    assert_eq!(next.await.unwrap(), Decision::Denied);
    assert!(fake.named("mcp-approval-resolved").is_empty());
}

#[tokio::test]
async fn silence_until_the_deadline_denies_and_tells_the_ui() {
    let (registry, fake) = setup(SHORT, MAX_QUEUE);
    let started = Instant::now();
    let decision = ask(&registry).await.unwrap();
    assert_eq!(decision, Decision::Denied, "no answer must never approve");
    assert!(started.elapsed() >= SHORT);
    let request = fake.named("mcp-approval-request").remove(0);
    assert_eq!(
        fake.named("mcp-approval-resolved"),
        [json!({"id": request["id"], "outcome": "expired"})]
    );
    // An answer after the deadline is refused.
    assert!(answer(&registry, &request["id"], true).is_err());
    assert_eq!(registry.approvals.lock().len(), 0);
}

#[tokio::test]
async fn the_fifth_request_is_refused_without_reaching_the_ui() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let calls: Vec<_> = (0..MAX_QUEUE).map(|_| ask(&registry)).collect();
    let shown = requests(&fake, MAX_QUEUE).await;
    assert_eq!(ask(&registry).await.unwrap(), Decision::Denied);
    assert_eq!(fake.named("mcp-approval-request").len(), MAX_QUEUE);
    // Room again once one is answered.
    assert!(answer(&registry, &shown[0]["id"], true).is_ok());
    let sixth = ask(&registry);
    let all = requests(&fake, MAX_QUEUE + 1).await;
    assert!(answer(&registry, &all[MAX_QUEUE]["id"], false).is_ok());
    assert_eq!(sixth.await.unwrap(), Decision::Denied);
    for (i, call) in calls.into_iter().enumerate() {
        if i > 0 {
            assert!(answer(&registry, &shown[i]["id"], i % 2 == 0).is_ok());
        }
        assert_eq!(
            call.await.unwrap(),
            if i == 0 || i % 2 == 0 {
                Decision::Approved
            } else {
                Decision::Denied
            },
            "request {i} gets its own answer"
        );
    }
}

#[tokio::test]
async fn a_repeated_answer_is_refused_and_the_first_stands() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let call = ask(&registry);
    let id = requests(&fake, 1).await[0]["id"].clone();
    assert!(answer(&registry, &id, false).is_ok());
    assert!(answer(&registry, &id, true).is_err());
    assert_eq!(call.await.unwrap(), Decision::Denied);
}

#[tokio::test]
async fn racing_answers_decide_exactly_once() {
    for _ in 0..50 {
        let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
        let call = ask(&registry);
        let id = requests(&fake, 1).await[0]["id"].clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = [true, false]
            .into_iter()
            .map(|approved| {
                let (registry, barrier, id) = (registry.clone(), barrier.clone(), id.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    answer(&registry, &id, approved).is_ok().then_some(approved)
                })
            })
            .collect();
        let winners: Vec<_> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(
            call.await.unwrap(),
            if winners[0] {
                Decision::Approved
            } else {
                Decision::Denied
            }
        );
    }
}

#[tokio::test]
async fn only_the_main_window_may_answer_and_a_stranger_does_not_consume_the_id() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let call = ask(&registry);
    let id = requests(&fake, 1).await[0]["id"].clone();
    let forged =
        registry
            .approvals
            .respond(&registry.window, false, json!({"id": id, "approved": true}));
    assert!(forged.is_err());
    assert_eq!(registry.approvals.lock().len(), 1);
    assert!(!call.is_finished());
    assert!(answer(&registry, &id, true).is_ok());
    assert_eq!(call.await.unwrap(), Decision::Approved);
}

#[tokio::test]
async fn an_unknown_id_is_refused_and_approves_nothing() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let call = ask(&registry);
    let id = requests(&fake, 1).await[0]["id"].clone();
    assert!(answer(&registry, &json!("f".repeat(64)), true).is_err());
    assert!(!call.is_finished());
    assert!(answer(&registry, &id, false).is_ok());
    assert_eq!(call.await.unwrap(), Decision::Denied);
}

#[tokio::test]
async fn a_malformed_answer_for_a_waiting_id_denies_it_and_closes_the_dialog() {
    for (name, response) in [
        ("string instead of bool", json!({"approved": "yes"})),
        ("number", json!({"approved": 1})),
        ("missing", json!({})),
        ("extra field", json!({"approved": true, "always": true})),
    ] {
        let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
        let call = ask(&registry);
        let id = requests(&fake, 1).await[0]["id"].clone();
        let mut response = response;
        response["id"] = id.clone();
        assert!(
            registry
                .approvals
                .respond(&registry.window, true, response)
                .is_err(),
            "{name}"
        );
        assert_eq!(call.await.unwrap(), Decision::Denied, "{name}");
        assert_eq!(
            fake.named("mcp-approval-resolved"),
            [json!({"id": id, "outcome": "cancelled"})],
            "{name}"
        );
        assert!(
            answer(&registry, &id, true).is_err(),
            "{name}: id must be spent"
        );
    }
    // Not even an id: nothing to attach it to.
    let (registry, _fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    for response in [
        json!(null),
        json!("x"),
        json!({"id": 3, "approved": true}),
        json!({"approved": true}),
    ] {
        assert!(registry
            .approvals
            .respond(&registry.window, true, response)
            .is_err());
    }
}

#[tokio::test]
async fn a_client_that_goes_away_cancels_its_request() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let call = ask(&registry);
    let id = requests(&fake, 1).await[0]["id"].clone();
    call.abort();
    let _ = call.await;
    assert_eq!(registry.approvals.lock().len(), 0);
    assert_eq!(
        fake.named("mcp-approval-resolved"),
        [json!({"id": id, "outcome": "cancelled"})]
    );
    assert!(
        answer(&registry, &id, true).is_err(),
        "a late answer cannot revive it"
    );
}

#[tokio::test]
async fn a_page_reload_denies_everything_waiting_and_a_close_refuses_new_requests() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let calls = [ask(&registry), ask(&registry)];
    let shown = requests(&fake, 2).await;
    registry.page_reloading();
    for call in calls {
        assert_eq!(call.await.unwrap(), Decision::Denied);
    }
    let mut resolved = fake.named("mcp-approval-resolved");
    resolved.sort_by_key(|v| v["id"].as_str().unwrap().to_owned());
    let mut expected: Vec<_> = shown
        .iter()
        .map(|r| json!({"id": r["id"], "outcome": "cancelled"}))
        .collect();
    expected.sort_by_key(|v| v["id"].as_str().unwrap().to_owned());
    assert_eq!(resolved, expected);
    let pending = ask(&registry);
    requests(&fake, 3).await;
    registry.shutdown();
    assert_eq!(pending.await.unwrap(), Decision::Denied);
    let before = fake.named("mcp-approval-request").len();
    assert_eq!(ask(&registry).await.unwrap(), Decision::Denied);
    assert_eq!(fake.named("mcp-approval-request").len(), before);
}

#[tokio::test]
async fn an_unavailable_window_denies_at_once() {
    let registry = Arc::new(Registry::default());
    assert_eq!(ask(&registry).await.unwrap(), Decision::Denied);
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    fake.deliver
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(ask(&registry).await.unwrap(), Decision::Denied);
    assert_eq!(registry.approvals.lock().len(), 0);
}

#[tokio::test]
async fn oversized_descriptions_are_denied_not_truncated() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    for (operation, target, summary) in [
        (
            "o".repeat(MAX_OPERATION + 1),
            "t".to_owned(),
            "s".to_owned(),
        ),
        ("o".to_owned(), "t".repeat(MAX_TARGET + 1), "s".to_owned()),
        ("o".to_owned(), "t".to_owned(), "s".repeat(MAX_SUMMARY + 1)),
    ] {
        let decision = registry
            .approvals
            .request(&registry.window, &operation, &target, &summary)
            .await;
        assert_eq!(decision, Decision::Denied);
    }
    assert!(fake.named("mcp-approval-request").is_empty());
}

// ---- F5, F6, F7 --------------------------------------------------------------

fn poll_once<F: std::future::Future>(
    future: &mut std::pin::Pin<Box<F>>,
) -> std::task::Poll<F::Output> {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    future.as_mut().poll(&mut cx)
}
fn ask_future(
    registry: &Arc<Registry>,
) -> std::pin::Pin<Box<impl std::future::Future<Output = Decision>>> {
    let registry = registry.clone();
    Box::pin(async move {
        registry
            .approvals
            .request(
                &registry.window,
                "write_file",
                "notes/a.md",
                "Replace 3 lines",
            )
            .await
    })
}

#[tokio::test]
async fn an_answer_after_the_deadline_is_refused_before_the_waiter_runs() {
    let (registry, fake) = setup(SHORT, MAX_QUEUE);
    let mut call = ask_future(&registry);
    assert!(poll_once(&mut call).is_pending());
    let id = fake.named("mcp-approval-request")[0]["id"].clone();
    // The waiter is not polled while the deadline passes, so it has not
    // removed the id: only the answer's own check can refuse the approval.
    std::thread::sleep(SHORT + Duration::from_millis(60));
    assert_eq!(registry.approvals.lock().len(), 1);
    assert_eq!(answer(&registry, &id, true), Err(REFUSED));
    assert_eq!(call.await, Decision::Denied);
    assert_eq!(
        fake.named("mcp-approval-resolved"),
        [json!({"id": id, "outcome": "expired"})]
    );
    assert_eq!(registry.approvals.lock().len(), 0);
}

#[tokio::test]
async fn an_approval_collected_after_the_deadline_is_not_an_approval() {
    let (registry, fake) = setup(SHORT, MAX_QUEUE);
    let mut call = ask_future(&registry);
    assert!(poll_once(&mut call).is_pending());
    let id = fake.named("mcp-approval-request")[0]["id"].clone();
    assert!(answer(&registry, &id, true).is_ok(), "in time");
    std::thread::sleep(SHORT + Duration::from_millis(60));
    assert_eq!(call.await, Decision::Denied);
}

#[tokio::test]
async fn an_answer_for_a_request_that_is_gone_reports_the_error() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let mut call = ask_future(&registry);
    assert!(poll_once(&mut call).is_pending());
    let id = fake.named("mcp-approval-request")[0]["id"].clone();
    // Put the entry back after the receiver is dropped: the send fails, and
    // the answer is not reported as accepted.
    let waiting = registry.approvals.take(id.as_str().unwrap()).unwrap();
    drop(call);
    registry
        .approvals
        .lock()
        .insert(id.as_str().unwrap().to_owned(), waiting);
    assert_eq!(answer(&registry, &id, true), Err(REFUSED));
}

#[tokio::test]
async fn a_full_queue_refusal_tells_the_ui_it_ended() {
    let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
    let calls: Vec<_> = (0..MAX_QUEUE).map(|_| ask(&registry)).collect();
    let shown = requests(&fake, MAX_QUEUE).await;
    assert!(fake.named("mcp-approval-resolved").is_empty());
    assert_eq!(ask(&registry).await.unwrap(), Decision::Denied);
    let resolved = fake.named("mcp-approval-resolved");
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0]["outcome"], "cancelled");
    assert_eq!(resolved[0].as_object().unwrap().len(), 2);
    // It names the refused request, never one of the four still waiting.
    assert!(shown
        .iter()
        .all(|request| request["id"] != resolved[0]["id"]));
    registry.page_reloading();
    for call in calls {
        assert_eq!(call.await.unwrap(), Decision::Denied);
    }
}

#[tokio::test]
async fn positional_sequences_and_null_never_approve() {
    for (name, response) in [
        ("sequence", json!(["x", true])),
        ("approved null", json!({"approved": null})),
    ] {
        let (registry, fake) = setup(Duration::from_secs(30), MAX_QUEUE);
        let call = ask(&registry);
        let id = requests(&fake, 1).await[0]["id"].clone();
        let mut response = response;
        if response.is_object() {
            response["id"] = id.clone();
        }
        assert!(registry
            .approvals
            .respond(&registry.window, true, response)
            .is_err());
        if name == "sequence" {
            // No id to look up: nothing was consumed; the real answer still works.
            assert_eq!(registry.approvals.lock().len(), 1);
            assert!(answer(&registry, &id, false).is_ok());
        }
        assert_eq!(call.await.unwrap(), Decision::Denied, "{name}");
    }
}
