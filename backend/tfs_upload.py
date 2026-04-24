"""
tfs_upload.py
Handles creating TFS Test Case work items and linking them to a User Story.
"""

import os
import re
import base64
import xml.sax.saxutils as saxutils
from urllib.parse import urlparse, parse_qs

import requests
from dotenv import load_dotenv

load_dotenv()

TFS_PAT = os.getenv("TFS_PAT", "")
TFS_USERNAME = os.getenv("TFS_USERNAME", "")
TFS_PASSWORD = os.getenv("TFS_PASSWORD", "")
TFS_DEFAULT_PLAN_URL = os.getenv("TFS_DEFAULT_PLAN_URL", "")


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def _pat_auth_header(pat: str) -> dict:
    """Return an Authorization header for TFS PAT authentication."""
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("utf-8")
    return {"Authorization": f"Basic {token}"}


def _get_auth(pat: str = "", username: str = "", password: str = ""):
    """Return (auth_object_or_None, extra_headers) depending on available credentials."""
    effective_pat = pat or TFS_PAT
    if effective_pat:
        return None, _pat_auth_header(effective_pat)

    # Fall back to NTLM if requests_ntlm is available
    effective_user = username or TFS_USERNAME
    effective_pass = password or TFS_PASSWORD
    
    try:
        from requests_ntlm import HttpNtlmAuth
        if effective_user and effective_pass:
            return HttpNtlmAuth(effective_user, effective_pass), {}
    except ImportError:
        pass

    return None, {}


# ---------------------------------------------------------------------------
# URL parser
# ---------------------------------------------------------------------------

def parse_tfs_url(tfs_link: str):
    """
    Given any TFS URL, return (collection_url, project_name, plan_id, suite_id).

    Handles patterns like:
      http://server:8080/tfs/genai/ProjectName/_workitems/edit/12345
      http://server:8080/tfs/genai/ProjectName
    """
    parsed = urlparse(tfs_link.strip())
    parts = [p for p in parsed.path.split("/") if p]

    # Find /tfs/ segment
    try:
        tfs_index = next(i for i, p in enumerate(parts) if p.lower() == "tfs")
    except StopIteration:
        raise ValueError(
            f"Cannot find '/tfs/' in the provided URL: {tfs_link}\n"
            "Expected format: http://server:port/tfs/collection/ProjectName/..."
        )

    if len(parts) < tfs_index + 3:
        raise ValueError(
            f"URL is too short to contain both collection and project name: {tfs_link}\n"
            "Expected format: http://server:port/tfs/collection/ProjectName/..."
        )

    collection_name = parts[tfs_index + 1]
    project_name = parts[tfs_index + 2]

    base = f"{parsed.scheme}://{parsed.netloc}"
    collection_url = f"{base}/tfs/{collection_name}"

    query = parse_qs(parsed.query or "")
    plan_id = query.get("planId", [None])[0]
    suite_id = query.get("suiteId", [None])[0]

    return collection_url, project_name, plan_id, suite_id


def _short_title(title: str, max_len: int = 95) -> str:
    """Ensure title is short and clean for TFS grid entry."""
    cleaned = " ".join((title or "").strip().split())
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rstrip() + "..."


# ---------------------------------------------------------------------------
# Steps XML builder
# ---------------------------------------------------------------------------

def _build_steps_xml(step_action: str, expected_result: str) -> str:
    """
    Build the XML string for the Microsoft.VSTS.TCM.Steps field.
    Splits step_action into multiple <step> elements.
    Splits by:
    1. Explicit numbering (1., 2., etc.)
    2. Newlines with bullet points (-, •, *)
    3. Simple newlines
    """
    # 1. Try to split by explicit numbering: "1. Action"
    action_lines = re.split(r'\d+\.\s+', step_action.strip())
    action_lines = [s.strip() for s in action_lines if s.strip()]
    
    # 2. If no numbered split found, try splitting by common bullet points or just newlines
    if len(action_lines) <= 1:
        # Split by newline and remove common bullet prefixes
        raw_lines = step_action.strip().split('\n')
        action_lines = []
        for line in raw_lines:
            line = line.strip()
            if not line: continue
            # Remove leading bullets: •, -, *, etc.
            line = re.sub(r'^[•\-\*]\s*', '', line)
            if line: action_lines.append(line)

    if not action_lines:
        action_lines = ["Execute test step"]

    # Do the same for expected results so we can try to match them 1-to-1 if possible
    raw_exp = expected_result.strip().split('\n')
    exp_lines = []
    for line in raw_exp:
        line = line.strip()
        if not line: continue
        line = re.sub(r'^[•\-\*]\s*', '', line)
        line = re.sub(r'^\d+\.\s*', '', line) # Remove numbers if present
        if line: exp_lines.append(line)

    step_elements = []
    for step_id, action_text in enumerate(action_lines, start=1):
        # Logic: 
        # - If we have the same number of actions and results, match them 1-to-1.
        # - Otherwise, put all results in the last step.
        if len(action_lines) == len(exp_lines):
            current_exp = exp_lines[step_id - 1]
        elif step_id == len(action_lines):
            current_exp = "\n".join(exp_lines)
        else:
            current_exp = ""

        action_html = saxutils.escape(f"<DIV><P>{saxutils.escape(action_text)}</P></DIV>")
        expected_html = saxutils.escape(f"<DIV><P>{saxutils.escape(current_exp)}</P></DIV>")

        step_elements.append(
            f'<step id="{step_id}" type="ValidateStep">'
            f'<parameterizedString isformatted="true">{action_html}</parameterizedString>'
            f'<parameterizedString isformatted="true">{expected_html}</parameterizedString>'
            f"<description/></step>"
        )

    last_id = len(step_elements)
    return f'<steps id="0" last="{last_id}">{"".join(step_elements)}</steps>'


# ---------------------------------------------------------------------------
# Single test case creator
# ---------------------------------------------------------------------------

def create_test_case(
    collection_url: str,
    project: str,
    title: str,
    step_action: str,
    expected_results: str,
    story_work_item_id: int,
    auth=None,
    extra_headers: dict = None,
) -> int:
    """
    Create one TFS Test Case work item, link it to the given User Story (if provided),
    and return the new test case ID.
    """
    steps_xml = _build_steps_xml(step_action, expected_results)

    payload = [
        {"op": "add", "path": "/fields/System.Title", "value": title},
        {"op": "add", "path": "/fields/Microsoft.VSTS.TCM.Steps", "value": steps_xml},
    ]
    
    # Only add story link if story_work_item_id is valid (not 0)
    if story_work_item_id and story_work_item_id > 0:
        story_url = f"{collection_url}/_apis/wit/workitems/{story_work_item_id}"
        payload.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "Microsoft.VSTS.Common.TestedBy-Reverse",
                "url": story_url,
                "attributes": {"comment": "Auto-linked by TFS Agent"},
            },
        })

    url = (
        f"{collection_url}/{project}/_apis/wit/workitems/"
        f"$Test%20Case?api-version=6.0"
    )

    headers = {"Content-Type": "application/json-patch+json"}
    if extra_headers:
        headers.update(extra_headers)

    auth_type = "None"
    if auth:
        auth_type = type(auth).__name__
    elif "Authorization" in headers:
        auth_type = "PAT (Basic)"

    print(f"[CREATE_TEST_CASE DEBUG] Creating: {title}", flush=True)
    print(f"[CREATE_TEST_CASE DEBUG] URL: {url}", flush=True)
    print(f"[CREATE_TEST_CASE DEBUG] Auth Type: {auth_type}", flush=True)
    
    # Log a sanitized version of the payload for debugging
    # print(f"[CREATE_TEST_CASE DEBUG] Payload: {json.dumps(payload, indent=2)}", flush=True)
    
    try:
        response = requests.patch(url, json=payload, auth=auth, headers=headers, verify=False, timeout=30)
    except Exception as e:
        print(f"[CREATE_TEST_CASE DEBUG] Exception during request: {str(e)}", flush=True)
        raise RuntimeError(f"Network error creating test case: {str(e)}")

    print(f"[CREATE_TEST_CASE DEBUG] Response status: {response.status_code}", flush=True)
    
    if response.status_code not in (200, 201):
        error_text = response.text[:400] if response.text else "No response body"
        print(f"[CREATE_TEST_CASE DEBUG] Error: {error_text}", flush=True)
        raise RuntimeError(
            f"Failed to create test case '{title}': "
            f"HTTP {response.status_code} — {error_text}"
        )

    tc_id = response.json()["id"]
    print(f"[CREATE_TEST_CASE DEBUG] Created test case ID: {tc_id}", flush=True)
    return tc_id


def add_test_cases_to_suite(
    collection_url: str,
    project: str,
    plan_id: str,
    suite_id: str,
    test_case_ids: list,
    auth=None,
    extra_headers: dict = None,
):
    """Add existing test cases into a static suite (equivalent to UI grid add)."""
    if not plan_id or not suite_id or not test_case_ids:
        return

    headers = {"Accept": "application/json; api-version=5.0"}
    if extra_headers:
        headers.update(extra_headers)

    failed_ids = []
    for tc_id in test_case_ids:
        # Try primary endpoint without api-version in URL (but put it in Accept header)
        url = f"{collection_url}/{project}/_apis/test/plans/{plan_id}/suites/{suite_id}/testcases/{tc_id}"
        
        print(f"[ADD_TEST_CASES DEBUG] Adding TC {tc_id} to suite {suite_id}: {url}", flush=True)
        
        try:
            response = requests.post(url, auth=auth, headers=headers, verify=False, timeout=30)
            print(f"[ADD_TEST_CASES DEBUG] Response status: {response.status_code}", flush=True)
            
            if response.status_code not in (200, 201):
                print(f"[ADD_TEST_CASES DEBUG] Failed - Status {response.status_code}: {response.text[:200]}", flush=True)
                failed_ids.append((tc_id, f"HTTP {response.status_code}"))
        except Exception as e:
            print(f"[ADD_TEST_CASES DEBUG] Exception: {str(e)}", flush=True)
            failed_ids.append((tc_id, str(e)))

    if failed_ids:
        failed_summary = "; ".join(
            [f"{tc_id} ({error})" for tc_id, error in failed_ids[:5]]
        )
        suffix = "" if len(failed_ids) <= 5 else f"; +{len(failed_ids) - 5} more"
        print(f"[ADD_TEST_CASES DEBUG] Final error summary: {failed_summary}{suffix}", flush=True)
        raise RuntimeError(
            f"Failed to add {len(failed_ids)} test case(s) to suite {suite_id}: "
            f"{failed_summary}{suffix}"
        )


def create_static_suite(
    collection_url: str,
    project: str,
    plan_id: str,
    suite_name: str,
    parent_suite_id: str = None,
    auth=None,
    extra_headers: dict = None,
) -> str:
    """Create a static suite and return the created suite ID as string."""
    if not plan_id:
        raise ValueError("plan_id is required to create a static suite.")

    target_parent = parent_suite_id or plan_id
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)

    payload = {
        "name": suite_name,
        "suiteType": "StaticTestSuite",
        "parentSuite": {"id": str(target_parent)},
    }

    # Handle case where collection_url includes the project name
    # Format: http://server:port/tfs/Collection/Project -> extract to /tfs/Collection
    import os
    from urllib.parse import urlparse, urlunparse
    
    parsed_url = urlparse(collection_url)
    path_parts = [p for p in parsed_url.path.split('/') if p]  # Split and filter empty
    
    print(f"[CREATE_SUITE DEBUG] Original URL: {collection_url}", flush=True)
    print(f"[CREATE_SUITE DEBUG] Path parts: {path_parts}", flush=True)
    print(f"[CREATE_SUITE DEBUG] Project: {project}", flush=True)
    
    # Remove project name from path if it's the last element
    if path_parts and path_parts[-1].lower() == project.lower():
        path_parts = path_parts[:-1]
        print(f"[CREATE_SUITE DEBUG] Removed project from path, new parts: {path_parts}", flush=True)
    
    # Reconstruct the base URL without the project
    base_path = '/' + '/'.join(path_parts)
    base_url = urlunparse((parsed_url.scheme, parsed_url.netloc, base_path, '', '', ''))
    
    print(f"[CREATE_SUITE DEBUG] Base URL (collection): {base_url}", flush=True)
    
    # Primary endpoint (lowercase 'plans' is correct)
    url = (
        f"{base_url}/{project}/_apis/test/plans/{plan_id}/suites"
        f"?api-version=6.0"
    )
    print(f"[CREATE_SUITE DEBUG] Final Primary URL: {url}", flush=True)
    response = requests.post(url, json=payload, auth=auth, headers=headers)
    print(f"[CREATE_SUITE DEBUG] Primary response status: {response.status_code}", flush=True)

    # Compatibility fallback for some servers
    if response.status_code not in (200, 201):
        fallback_url = (
            f"{base_url}/{project}/_apis/testplan/plans/{plan_id}/suites"
            f"?api-version=6.1-preview.1"
        )
        print(f"[CREATE_SUITE DEBUG] Fallback URL: {fallback_url}", flush=True)
        response = requests.post(fallback_url, json=payload, auth=auth, headers=headers)
        print(f"[CREATE_SUITE DEBUG] Fallback response status: {response.status_code}", flush=True)

    if response.status_code not in (200, 201):
        error_msg = f"HTTP {response.status_code}"
        try:
            error_msg += f" — {response.text[:200]}"
        except:
            pass
        raise RuntimeError(
            f"Failed to create static suite '{suite_name}': {error_msg}"
        )

    created_suite = response.json().get("id")
    if not created_suite:
        raise RuntimeError("Static suite created but response did not include suite id.")
    return str(created_suite)


# ---------------------------------------------------------------------------
# Batch uploader
# ---------------------------------------------------------------------------

def upload_test_cases(
    tfs_link: str,
    work_item_id: int,
    test_cases: list,
    suite_name: str = "",
    pat: str = "",
    username: str = "",
    password: str = "",
) -> list:
    """
    Upload a list of test case dicts to TFS and link them to work_item_id.

    Args:
        tfs_link:     Any URL pointing into the TFS project
                      (e.g. the user story URL or project home URL).
        work_item_id: TFS User Story ID to link test cases against.
        test_cases:   List of dicts with keys: title, step_action, expected_results
        pat:          Optional PAT override (uses .env TFS_PAT by default).
        username:     Optional username override.
        password:     Optional password override.

    Returns:
        List of created test case IDs.
    """
    link_to_use = tfs_link.strip() if tfs_link else ""
    if not link_to_use and suite_name:
        link_to_use = TFS_DEFAULT_PLAN_URL.strip()

    if not link_to_use:
        raise ValueError(
            "A TFS link is required. For suite-name-only mode, set TFS_DEFAULT_PLAN_URL in .env"
        )

    collection_url, project, plan_id, suite_id = parse_tfs_url(link_to_use)
    auth, extra_headers = _get_auth(pat, username, password)

    created_ids = []
    failed = []

    print(f"\nUploading {len(test_cases)} test case(s) to TFS project '{project}'...")
    print(f"Collection URL : {collection_url}")
    print(f"Linking to User Story ID : {work_item_id}\n")
    if plan_id and suite_id:
        print(f"Static suite target detected: planId={plan_id}, suiteId={suite_id}\n")

    if suite_name:
        if not plan_id:
            raise ValueError(
                "Suite name was provided but planId is missing. "
                "Use a test plan URL (with planId) or configure TFS_DEFAULT_PLAN_URL."
            )
        created_suite_id = create_static_suite(
            collection_url=collection_url,
            project=project,
            plan_id=str(plan_id),
            suite_name=suite_name.strip(),
            parent_suite_id=str(suite_id) if suite_id else None,
            auth=auth,
            extra_headers=extra_headers,
        )
        suite_id = created_suite_id
        print(f"Created static suite '{suite_name}' with suiteId={suite_id}.\n")

    for index, tc in enumerate(test_cases, start=1):
        title = _short_title(tc.get("title", f"Test Case {index}"))
        step_action = tc.get("step_action", "").strip()
        expected_results = tc.get("expected_results", "").strip()

        try:
            tc_id = create_test_case(
                collection_url=collection_url,
                project=project,
                title=title,
                step_action=step_action,
                expected_results=expected_results,
                story_work_item_id=work_item_id,
                auth=auth,
                extra_headers=extra_headers,
            )
            created_ids.append(tc_id)
            print(f"  [{index}/{len(test_cases)}] Created TC #{tc_id} — {title}")
        except Exception as error:
            failed.append((index, title, str(error)))
            print(f"  [{index}/{len(test_cases)}] FAILED — {title}: {error}")

    print(f"\nUpload complete: {len(created_ids)} created, {len(failed)} failed.")

    if created_ids and plan_id and suite_id:
        try:
            add_test_cases_to_suite(
                collection_url=collection_url,
                project=project,
                plan_id=plan_id,
                suite_id=suite_id,
                test_case_ids=created_ids,
                auth=auth,
                extra_headers=extra_headers,
            )
            print(f"Added {len(created_ids)} test case(s) to static suite {suite_id}.")
        except Exception as suite_error:
            print(f"Warning: Could not add test cases to static suite: {suite_error}")

    if failed:
        print("Failed test cases:")
        for idx, title, err in failed:
            print(f"  #{idx} '{title}': {err}")

    return created_ids


# ---------------------------------------------------------------------------
# Table row → dict parser
# ---------------------------------------------------------------------------

def parse_test_case_rows(rows: list) -> list:
    """
    Convert _extract_markdown_table_rows output into a list of dicts.
    Expects header row: [Title, Step Action, Expected Results]
    Returns list of {"title": ..., "step_action": ..., "expected_results": ...}
    """
    if not rows or len(rows) < 2:
        return []

    # Normalise header
    header = [cell.strip().lower() for cell in rows[0]]

    def _col(name_variants):
        for variant in name_variants:
            for i, h in enumerate(header):
                if variant in h:
                    return i
        return None

    title_col = _col(["title"])
    action_col = _col(["step action", "action", "steps"])
    result_col = _col(["expected result", "expected"])

    if title_col is None or action_col is None or result_col is None:
        return []

    test_cases = []
    for row in rows[1:]:
        if len(row) <= max(title_col, action_col, result_col):
            continue
        title = row[title_col].strip()
        if not title or set(title.replace("-", "").replace(":", "").strip()) == set():
            continue  # skip separator rows
        test_cases.append(
            {
                "title": title,
                "step_action": row[action_col].strip(),
                "expected_results": row[result_col].strip(),
            }
        )

    return test_cases
