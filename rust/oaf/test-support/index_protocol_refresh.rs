fn all_language_writer_arguments(max_files: usize) -> Value {
    let mut arguments = writer_arguments();
    arguments["maxFiles"] = json!(max_files);
    arguments["languages"] = json!([]);
    arguments
}

fn exact_query(workspace: &Path, symbol: &str) -> Value {
    execute_request(
        parse_request(request(
            "index.query",
            json!({ "kind": "exact", "query": symbol, "limit": 10 }),
        ))
        .unwrap(),
        workspace,
        "2.0.0",
    )
    .unwrap()
}

fn query_contains(response: &Value, symbol: &str) -> bool {
    response["result"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["label"].as_str().is_some_and(|label| label.contains(symbol)))
}

#[test]
fn bounded_refresh_never_replaces_unexamined_files_and_complete_refresh_recovers() {
    #[derive(Clone, Copy, Debug)]
    enum Mutation {
        None,
        AddEarly,
        AddLate,
        DeleteSelected,
        DeleteUnselected,
    }

    for mutation in [
        Mutation::None,
        Mutation::AddEarly,
        Mutation::AddLate,
        Mutation::DeleteSelected,
        Mutation::DeleteUnselected,
    ] {
        let workspace = tempdir().unwrap();
        fs::write(
            workspace.path().join("a.ts"),
            "export function alphaValue(): number { return 1; }\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("m.py"),
            "def middle_value():\n    return 1\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("z.go"),
            "package sample\nfunc ZuluValue() int { return 1 }\n",
        )
        .unwrap();
        let build = execute_request(
            parse_request(request("index.build", all_language_writer_arguments(1000))).unwrap(),
            workspace.path(),
            "2.0.0",
        )
        .unwrap();
        let generation = build["result"]["activeGeneration"].clone();
        let committed_summary = build["result"]["summary"].clone();
        let index_path = workspace.path().join(INDEX_RELATIVE_PATH);
        let before = bundle_snapshot(&index_path);

        let (added_symbol, deleted_symbol) = match mutation {
            Mutation::None => (None, None),
            Mutation::AddEarly => {
                fs::write(
                    workspace.path().join("0.java"),
                    "final class AddedEarly { static int value() { return 1; } }\n",
                )
                .unwrap();
                (Some("AddedEarly"), None)
            }
            Mutation::AddLate => {
                fs::write(
                    workspace.path().join("zz.java"),
                    "final class AddedLate { static int value() { return 1; } }\n",
                )
                .unwrap();
                (Some("AddedLate"), None)
            }
            Mutation::DeleteSelected => {
                fs::remove_file(workspace.path().join("a.ts")).unwrap();
                (None, Some("alphaValue"))
            }
            Mutation::DeleteUnselected => {
                fs::remove_file(workspace.path().join("z.go")).unwrap();
                (None, Some("ZuluValue"))
            }
        };

        let bounded = execute_request(
            parse_request(request("index.refresh", all_language_writer_arguments(1))).unwrap(),
            workspace.path(),
            "2.0.0",
        )
        .unwrap();
        assert_eq!(bounded["result"]["operation"], "index.refresh", "{mutation:?}");
        assert_eq!(bounded["result"]["state"], "partial", "{mutation:?}");
        assert_eq!(bounded["result"]["freshness"], "partial", "{mutation:?}");
        assert_eq!(bounded["result"]["health"]["status"], "ready", "{mutation:?}");
        assert_eq!(bounded["result"]["activeGeneration"], generation, "{mutation:?}");
        assert_eq!(bounded["result"]["summary"], committed_summary, "{mutation:?}");
        for measurement in [
            "localFilesWritten",
            "parsedFileCount",
            "changedFileCount",
            "deletedFileCount",
        ] {
            assert_eq!(
                bounded["result"]["measurements"][measurement], 0,
                "{mutation:?}: {measurement}"
            );
        }
        let diagnostics = bounded["result"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value["code"].as_str())
            .collect::<BTreeSet<_>>();
        assert!(diagnostics.contains("source_index_refresh_partial"), "{mutation:?}");
        assert!(
            diagnostics.contains("source_index_refresh_file_budget_exceeded"),
            "{mutation:?}"
        );
        assert_eq!(
            diagnostics.contains("source_index_files_omitted"),
            matches!(mutation, Mutation::DeleteSelected | Mutation::DeleteUnselected),
            "{mutation:?}"
        );
        assert_eq!(bundle_snapshot(&index_path), before, "{mutation:?}");

        if matches!(mutation, Mutation::None) {
            for symbol in ["alphaValue", "middle_value", "ZuluValue"] {
                let stored = exact_query(workspace.path(), symbol);
                assert_eq!(stored["result"]["activeGeneration"], generation, "{mutation:?}");
                assert!(query_contains(&stored, symbol), "{mutation:?}: {symbol}");
            }
        } else {
            let error = execute_request(
                parse_request(request(
                    "index.query",
                    json!({ "kind": "exact", "query": "middle_value", "limit": 10 }),
                ))
                .unwrap(),
                workspace.path(),
                "2.0.0",
            )
            .unwrap_err();
            assert_eq!(safe_error_code(&error), "source_index_refresh_required");
            assert_eq!(bundle_snapshot(&index_path), before, "{mutation:?}");
        }

        let recovered = execute_request(
            parse_request(request(
                "index.refresh",
                all_language_writer_arguments(1000),
            ))
            .unwrap(),
            workspace.path(),
            "2.0.0",
        )
        .unwrap();
        assert_eq!(recovered["result"]["state"], "ready", "{mutation:?}");
        assert_eq!(recovered["result"]["freshness"], "current", "{mutation:?}");
        assert_eq!(recovered["result"]["health"]["status"], "ready", "{mutation:?}");
        assert_eq!(recovered["result"]["summary"]["omittedCount"], 0, "{mutation:?}");
        match mutation {
            Mutation::None => {
                assert_eq!(recovered["result"]["activeGeneration"], generation);
                assert_eq!(recovered["result"]["measurements"]["localFilesWritten"], 0);
                assert_eq!(recovered["result"]["summary"]["fileCount"], 3);
            }
            Mutation::AddEarly | Mutation::AddLate => {
                assert_ne!(recovered["result"]["activeGeneration"], generation);
                assert_eq!(recovered["result"]["measurements"]["changedFileCount"], 1);
                assert_eq!(recovered["result"]["summary"]["fileCount"], 4);
                let symbol = added_symbol.unwrap();
                assert!(query_contains(&exact_query(workspace.path(), symbol), symbol));
            }
            Mutation::DeleteSelected | Mutation::DeleteUnselected => {
                assert_ne!(recovered["result"]["activeGeneration"], generation);
                assert_eq!(recovered["result"]["measurements"]["deletedFileCount"], 1);
                assert_eq!(recovered["result"]["summary"]["fileCount"], 2);
                let symbol = deleted_symbol.unwrap();
                assert!(!query_contains(&exact_query(workspace.path(), symbol), symbol));
            }
        }
        let recovered_snapshot = bundle_snapshot(&index_path);
        let status = execute_request(
            parse_request(request("index.status", json!({}))).unwrap(),
            workspace.path(),
            "2.0.0",
        )
        .unwrap();
        assert_eq!(status["result"]["freshness"], "current", "{mutation:?}");
        assert_eq!(bundle_snapshot(&index_path), recovered_snapshot, "{mutation:?}");
    }
}
