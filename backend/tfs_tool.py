import os
import re
import json
import base64
import requests
import pandas as pd
from datetime import datetime, timedelta
from dotenv import load_dotenv
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import logging
import sys
from pathlib import Path

# Ensure logging is configured and get logger
log_dir = Path(__file__).parent.parent / "logs"
log_file = log_dir / "backend.log"

# Get or configure root logger
root_logger = logging.getLogger()
if not root_logger.handlers:  # Only configure if not already done
    log_dir.mkdir(exist_ok=True)
    handler = logging.FileHandler(log_file)
    handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)

load_dotenv()

BASE_URL = os.getenv("TFS_BASE_URL", "").strip()
DEFAULT_PLAN_URL = os.getenv("TFS_DEFAULT_PLAN_URL", "").strip()
USERNAME = os.getenv("TFS_USERNAME", "").strip()
PASSWORD = os.getenv("TFS_PASSWORD", "")
PAT = os.getenv("TFS_PAT", "").strip()


def _derive_base_url(default_plan_url: str) -> str:
    value = (default_plan_url or "").strip()
    if not value:
        return ""
    try:
        parsed = urlparse(value)
        parts = [p for p in parsed.path.split("/") if p]
        try:
            tfs_index = next(i for i, p in enumerate(parts) if p.lower() == "tfs")
        except StopIteration:
            return ""
        if len(parts) < tfs_index + 2:
            return ""
        collection_name = parts[tfs_index + 1]
        return f"{parsed.scheme}://{parsed.netloc}/tfs/{collection_name}"
    except Exception:
        return ""


def sanitize_params(params: dict) -> dict:
    """
    Returns a copy of params with sensitive keys masked for logging.
    """
    if not isinstance(params, dict):
        return params
    
    sensitive_keys = {
        'password', 'pat', 'pat_token', 'token', 'authorization', 
        'auth_token', 'secret', 'key', 'api_key'
    }
    
    sanitized = params.copy()
    for k, v in sanitized.items():
        if any(sk in k.lower() for sk in sensitive_keys):
            sanitized[k] = "********"
        elif isinstance(v, dict):
            sanitized[k] = sanitize_params(v)
            
    return sanitized


def _normalize_tfs_url_for_api(url_value: str) -> str:
    """
    Normalize user-pasted TFS web URLs (queries/boards/plans/etc.) to an API-safe base URL.
    Examples:
      .../tfs/GenAI/TruDocs/_queries/all/ -> .../tfs/GenAI/TruDocs
      .../tfs/GenAI/_apis/... -> .../tfs/GenAI
    """
    value = (url_value or "").strip()
    if not value:
        return ""
    try:
        parsed = urlparse(value)
        parts = [p for p in parsed.path.split("/") if p]
        if not parts:
            return f"{parsed.scheme}://{parsed.netloc}"

        cut_idx = None
        for i, part in enumerate(parts):
            if part.startswith("_"):
                cut_idx = i
                break

        if cut_idx is not None:
            parts = parts[:cut_idx]

        normalized_path = "/" + "/".join(parts)
        return f"{parsed.scheme}://{parsed.netloc}{normalized_path}".rstrip("/")
    except Exception:
        return value.rstrip("/")


if not BASE_URL:
    BASE_URL = _derive_base_url(DEFAULT_PLAN_URL)


def _pat_auth_header(pat: str) -> dict:
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("utf-8")
    return {"Authorization": f"Basic {token}"}

def _basic_auth_header(username: str, password: str) -> dict:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("utf-8")
    return {"Authorization": f"Basic {token}"}

def _username_variants(username: str, domain: str = None) -> list[str]:
    u = (username or "").strip()
    d = (domain or "").strip()
    if not u:
        return []

    out = [u]
    if "\\" in u:
        short = u.split("\\", 1)[1].strip()
        if short:
            out.append(short)
    if "@" in u:
        local = u.split("@", 1)[0].strip()
        if local:
            out.append(local)
            if d:
                out.append(f"{d}\\{local}")
    else:
        if d and "\\" not in u:
            out.append(f"{d}\\{u}")

    seen = set()
    deduped = []
    for v in out:
        if v and v not in seen:
            deduped.append(v)
            seen.add(v)
    return deduped


def _get_auth_and_headers(username: str = None, password: str = None, pat: str = None):
    """Get authentication headers for TFS requests
    
    Args:
        username: TFS username (for NTLM auth)
        password: TFS password (for NTLM auth)
        pat: Personal Access Token
    """
    # If caller explicitly passed auth params, do not silently fall back to env PAT/user.
    has_user = bool((username or "").strip())
    has_pass = bool(password or "")
    has_pat = bool((pat or "").strip())
    explicit_auth = has_user or has_pass or has_pat
    if explicit_auth:
        pat = (pat or "").strip()
        username = (username or "").strip()
        password = password or ""
    else:
        pat = (PAT or "").strip()
        username = (USERNAME or "").strip()
        password = PASSWORD or ""
    
    if pat:
        return None, _pat_auth_header(pat)

    try:
        from requests_ntlm import HttpNtlmAuth
        if username and password:
            return HttpNtlmAuth(username, password), {}
    except ImportError:
        pass

    # Fallback: send Basic auth with username/password when NTLM is unavailable
    # or not negotiated for the current server setup.
    if username and password:
        return None, _basic_auth_header(username, password)

    return None, {}


def html_to_text(html_str):
    """Convert TFS HTML back to plain text preserving newlines and bold markers."""
    if not html_str:
        return ""
    
    # Pre-processing for better list and block formatting
    # Replace list items with bullets
    html_str = re.sub(r'<li>', '\n• ', html_str, flags=re.IGNORECASE)
    html_str = re.sub(r'</li>', '', html_str, flags=re.IGNORECASE)
    
    # Convert <b>text</b> back to **text**
    text = re.sub(r'<b>(.*?)</b>', r'**\1**', html_str, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r'<strong>(.*?)</strong>', r'**\1**', text, flags=re.IGNORECASE | re.DOTALL)
    
    # Convert <br/> and <br> to newlines
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    
    # Convert div/p tags to newlines
    text = re.sub(r'</?(div|p|h1|h2|h3|h4|h5|h6)[^>]*>', '\n', text, flags=re.IGNORECASE)
    
    # Strip remaining HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    
    # Unescape HTML entities
    text = (text.replace('&amp;', '&')
                .replace('&lt;', '<')
                .replace('&gt;', '>')
                .replace('&nbsp;', ' ')
                .replace('&quot;', '"')
                .replace('&#39;', "'"))
    
    # Cleanup newlines: collapse multiple newlines, ensure consistent spacing
    text = re.sub(r'\n\s*\n', '\n\n', text)
    return text.strip()


def fetch_user_story_details(work_item_id, base_url: str = None, username: str = None, password: str = None, pat: str = None):
    """Fetch user story details from TFS as structured fields."""
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL. Set TFS_BASE_URL in .env or provide base_url parameter")

    url = f"{url_base}/_apis/wit/workitems/{work_item_id}?api-version=6.0"
    auth, headers = _get_auth_and_headers(username, password, pat)

    response = requests.get(url, auth=auth, headers=headers, timeout=60)
    response.raise_for_status()

    data = response.json()

    fields = data.get("fields", {})
    title = fields.get("System.Title", "")
    html_description = fields.get("System.Description", "")
    html_acceptance = fields.get("Microsoft.VSTS.Common.AcceptanceCriteria", "")

    description = html_to_text(html_description)
    acceptance_criteria = html_to_text(html_acceptance)

    return {
        "id": work_item_id,
        "title": title,
        "description": description,
        "acceptance_criteria": acceptance_criteria,
        "state": fields.get("System.State", ""),
        "work_item_type": fields.get("System.WorkItemType", ""),
        "assigned_to": fields.get("System.AssignedTo", ""),
        "iteration_path": fields.get("System.IterationPath", ""),
        "area_path": fields.get("System.AreaPath", ""),
    }


def fetch_user_story(work_item_id, base_url: str = None, username: str = None, password: str = None, pat: str = None):
    """Fetch a user story from TFS as formatted text for prompts."""
    details = fetch_user_story_details(
        work_item_id=work_item_id,
        base_url=base_url,
        username=username,
        password=password,
        pat=pat,
    )

    return f"""
    Title:
    {details.get("title", "")}

    Description:
    {details.get("description", "")}

    Acceptance Criteria:
    {details.get("acceptance_criteria", "")}
    """


def _extract_project_from_tfs_url(value: str) -> str:
    if not value:
        return ""
    try:
        parsed = urlparse(value)
        parts = [p for p in parsed.path.split("/") if p]
        tfs_idx = next((i for i, p in enumerate(parts) if p.lower() == "tfs"), -1)
        if tfs_idx >= 0 and len(parts) > tfs_idx + 2:
            project = parts[tfs_idx + 2]
            if project and not project.startswith("_"):
                return project
    except Exception:
        pass
    return ""


def _split_collection_and_project(url_value: str) -> tuple[str, str]:
    """
    Return (collection_base_url, project_name_hint) from a normalized tfs URL.
    Example:
      http://host/tfs/GenAI/TruDocs -> (http://host/tfs/GenAI, TruDocs)
      http://host/tfs/GenAI         -> (http://host/tfs/GenAI, "")
    """
    value = _normalize_tfs_url_for_api(url_value or "")
    if not value:
        return "", ""
    try:
        parsed = urlparse(value)
        parts = [p for p in parsed.path.split("/") if p]
        tfs_idx = next((i for i, p in enumerate(parts) if p.lower() == "tfs"), -1)
        if tfs_idx < 0 or len(parts) < tfs_idx + 2:
            return value.rstrip("/"), ""
        collection_parts = parts[: tfs_idx + 2]
        collection_base = f"{parsed.scheme}://{parsed.netloc}/{'/'.join(collection_parts)}".rstrip("/")
        project_hint = parts[tfs_idx + 2] if len(parts) > tfs_idx + 2 else ""
        if project_hint.startswith("_"):
            project_hint = ""
        return collection_base, project_hint
    except Exception:
        return value.rstrip("/"), ""


def _discover_projects(collection_base: str, auth, headers) -> list[str]:
    try:
        res = requests.get(
            f"{collection_base}/_apis/projects",
            params={"api-version": "6.0"},
            auth=auth,
            headers=headers,
            timeout=6,
        )
        if res.status_code != 200:
            return []
        data = res.json()
        names = []
        for row in data.get("value", []):
            n = (row.get("name") or "").strip()
            if n:
                names.append(n)
        return names
    except Exception:
        return []


def _fetch_team_iterations(url_base: str, project_name: str, auth, headers) -> list[dict]:
    api_versions = ["6.0", "5.1"]
    candidate_urls = [
        f"{url_base}/{project_name}/_apis/work/teamsettings/iterations",
        f"{url_base}/{project_name}/{project_name}/_apis/work/teamsettings/iterations",
    ]
    for endpoint in candidate_urls:
        for api_version in api_versions:
            try:
                res = requests.get(
                    endpoint,
                    params={"api-version": api_version},
                    auth=auth,
                    headers=headers,
                    timeout=6,
                )
                if res.status_code != 200:
                    continue
                rows = res.json().get("value", [])
                if rows:
                    return rows
            except Exception:
                continue
    return []


def _fetch_classification_iterations(url_base: str, project_name: str, auth, headers) -> list[dict]:
    api_versions = ["6.0", "5.1"]
    for api_version in api_versions:
        try:
            res = requests.get(
                f"{url_base}/{project_name}/_apis/wit/classificationnodes/iterations",
                params={"api-version": api_version, "$depth": 10},
                auth=auth,
                headers=headers,
                timeout=6,
            )
            if res.status_code != 200:
                continue
            root = res.json()
            out = []

            def walk(node):
                path = node.get("path", "")
                attrs = node.get("attributes", {}) or {}
                if path:
                    out.append(
                        {
                            "path": path,
                            "attributes": {
                                "startDate": attrs.get("startDate"),
                                "finishDate": attrs.get("finishDate"),
                            },
                        }
                    )
                for child in node.get("children", []) or []:
                    walk(child)

            walk(root)
            if out:
                return out
        except Exception:
            continue
    return []


def _normalize_iteration_rows(rows: list[dict]) -> list[dict]:
    now = datetime.utcnow()
    normalized = []
    for row in rows:
        attrs = row.get("attributes", {}) or {}
        path = (row.get("path") or "").strip()
        if not path:
            continue
            
        # Normalize path: remove leading \
        path = path.lstrip('\\')
        start_date = attrs.get("startDate")
        finish_date = attrs.get("finishDate")
        time_frame = attrs.get("timeFrame", "unknown")

        if time_frame == "unknown" and (start_date or finish_date):
            try:
                sdt = pd.to_datetime(start_date, errors="coerce") if start_date else None
                fdt = pd.to_datetime(finish_date, errors="coerce") if finish_date else None
                if sdt is not None and pd.notna(sdt) and fdt is not None and pd.notna(fdt):
                    if sdt.to_pydatetime() <= now <= fdt.to_pydatetime():
                        time_frame = "current"
                    elif now < sdt.to_pydatetime():
                        time_frame = "future"
                    else:
                        time_frame = "past"
            except Exception:
                pass

        normalized.append(
            {
                "path": path,
                "time_frame": time_frame or "unknown",
                "start_date": start_date,
                "finish_date": finish_date,
            }
        )

    seen = set()
    out = []
    for row in normalized:
        p = row["path"]
        if p not in seen:
            seen.add(p)
            out.append(row)
    return out


def fetch_iteration_options(base_url: str = None, username: str = None, password: str = None, pat: str = None, default_plan_url: str = None):
    """
    Fetch available iteration paths and return a normalized list.
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL or "")
    plan_url = default_plan_url or DEFAULT_PLAN_URL
    if not url_base:
        raise ValueError("Missing TFS base URL. Set TFS_BASE_URL or provide base_url parameter")

    try:
        auth, headers = _get_auth_and_headers(username, password, pat)
        collection_base, project_hint_from_base = _split_collection_and_project(url_base)
        if not collection_base:
            collection_base = url_base

        project_candidates = []
        for candidate in (
            _extract_project_from_tfs_url(plan_url),
            project_hint_from_base,
            _extract_project_from_tfs_url(url_base),
        ):
            if candidate and candidate not in project_candidates:
                project_candidates.append(candidate)

        for name in _discover_projects(collection_base, auth, headers):
            if name not in project_candidates:
                project_candidates.append(name)

        if not project_candidates:
            return []

        for project_name in project_candidates:
            team_rows = _fetch_team_iterations(collection_base, project_name, auth, headers)
            normalized = _normalize_iteration_rows(team_rows)
            if normalized:
                return normalized

            classification_rows = _fetch_classification_iterations(collection_base, project_name, auth, headers)
            normalized = _normalize_iteration_rows(classification_rows)
            if normalized:
                return normalized

        return []
    except Exception as e:
        print(f"DEBUG: Error in fetch_iteration_options: {str(e)}")
        return []


def fetch_current_iteration(base_url: str = None, username: str = None, password: str = None, pat: str = None, default_plan_url: str = None):
    """
    Fetch the current active iteration/sprint path from TFS.
    """
    rows = fetch_iteration_options(
        base_url=base_url,
        username=username,
        password=password,
        pat=pat,
        default_plan_url=default_plan_url,
    )
    if not rows:
        return ""

    current = next((r.get("path") for r in rows if r.get("time_frame") == "current"), None)
    if current:
        return current

    return rows[0].get("path", "")


def fetch_area_options(base_url: str = None, username: str = None, password: str = None, pat: str = None, default_plan_url: str = None):
    """
    Fetch available area paths from TFS.
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL or "")
    if not url_base:
        raise ValueError("Missing TFS base URL. Set TFS_BASE_URL or provide base_url parameter")

    try:
        auth, headers = _get_auth_and_headers(username, password, pat)
        collection_base, project_hint_from_base = _split_collection_and_project(url_base)
        if not collection_base:
            collection_base = url_base

        project_candidates = []
        for candidate in (
            project_hint_from_base,
            _extract_project_from_tfs_url(url_base),
        ):
            if candidate and candidate not in project_candidates:
                project_candidates.append(candidate)

        for name in _discover_projects(collection_base, auth, headers):
            if name not in project_candidates:
                project_candidates.append(name)

        if not project_candidates:
            return []

        for project_name in project_candidates:
            api_versions = ["6.0", "5.1"]
            for api_version in api_versions:
                try:
                    res = requests.get(
                        f"{collection_base}/{project_name}/_apis/wit/classificationnodes/areas",
                        params={"api-version": api_version, "$depth": 10},
                        auth=auth,
                        headers=headers,
                        timeout=6,
                    )
                    if res.status_code != 200:
                        continue
                    
                    root = res.json()
                    areas = []
                    
                    def walk(node):
                        path = node.get("path", "")
                        if path:
                            # Normalize path: remove leading \
                            normalized_path = path.lstrip('\\')
                            areas.append({
                                "path": normalized_path,
                                "display_name": normalized_path.split("\\")[-1] if "\\" in normalized_path else normalized_path
                            })
                        
                        children = node.get("children", [])
                        for child in children:
                            walk(child)
                    
                    walk(root)
                    
                    if areas:
                        return sorted(areas, key=lambda x: x["path"])
                    
                except Exception:
                    continue
        
        return []
    except Exception as e:
        print(f"DEBUG: Error in fetch_area_options: {str(e)}")
        return []


def upload_attachment(
    file_name: str,
    file_content_base64: str,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
) -> dict:
    """
    Upload an attachment to TFS.
    
    Args:
        file_name: Name of the file
        file_content_base64: Base64 encoded file content
        base_url: TFS base URL
        pat: Personal Access Token
        
    Returns:
        Dict with 'id' and 'url' of the uploaded attachment
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    # Clean base64 data (remove prefix if present)
    if "," in file_content_base64:
        file_content_base64 = file_content_base64.split(",")[1]
    
    file_content = base64.b64decode(file_content_base64)
    
    url = f"{url_base}/_apis/wit/attachments?fileName={file_name}&api-version=6.0"
    
    auth, headers = _get_auth_and_headers(username, password, pat)
    headers = (headers or {}).copy()
    headers["Content-Type"] = "application/octet-stream"
    
    response = requests.post(
        url,
        auth=auth,
        headers=headers,
        data=file_content,
        timeout=60
    )
    response.raise_for_status()
    
    return response.json()


def remove_all_attachments(
    work_item_id: int,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
) -> bool:
    """
    Remove all attachments from a work item before adding new ones.
    
    Args:
        work_item_id: Work item ID
        base_url: TFS base URL
        pat: Personal Access Token
        username: TFS username
        password: TFS password
        
    Returns:
        True if successful or no attachments, False otherwise
    """
    logger = logging.getLogger(__name__)
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    try:
        # Fetch work item with all relations
        url = f"{url_base}/_apis/wit/workitems/{work_item_id}?api-version=6.0&$expand=Relations"
        auth, headers = _get_auth_and_headers(username, password, pat)
        
        response = requests.get(url, auth=auth, headers=headers, timeout=30)
        if response.status_code != 200:
            # Can't fetch, return silently
            return False
        
        data = response.json()
        relations = data.get('relations', [])
        
        # Filter for attachment relations only
        attachment_relations = [r for r in relations if r.get('rel') == 'AttachedFile']
        
        if not attachment_relations:
            # No attachments to remove
            return True
        
        # Remove each attachment by index
        # Build patch document in reverse order to avoid index shifting
        patch_document = []
        for i, rel in enumerate(relations):
            if rel.get('rel') == 'AttachedFile':
                # Remove by relation URL
                patch_document.append({
                    "op": "remove",
                    "path": f"/relations/{i}"
                })
        
        if not patch_document:
            return True
        
        # Apply removals in reverse order to preserve indices
        headers = (headers or {}).copy()
        headers["Content-Type"] = "application/json-patch+json"
        
        update_url = f"{url_base}/_apis/wit/workitems/{work_item_id}?api-version=6.0"
        response = requests.patch(
            update_url,
            auth=auth,
            headers=headers,
            json=patch_document,
            timeout=30
        )
        
        return response.status_code in [200, 201]
    except Exception as e:
        logger.error(f"❌ Error removing attachments from work item {work_item_id}: {str(e)}")
        return False


def link_attachment_to_work_item(
    work_item_id: int,
    attachment_url: str,
    comment: str = "Attached by TFS Agent",
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
) -> requests.Response:
    """
    Link an uploaded attachment to a work item.
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    url = f"{url_base}/_apis/wit/workitems/{work_item_id}?api-version=6.0"
    
    patch_document = [
        {
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "AttachedFile",
                "url": attachment_url,
                "attributes": {
                    "comment": comment
                }
            }
        }
    ]
    
    auth, headers = _get_auth_and_headers(username, password, pat)
    headers = (headers or {}).copy()
    headers["Content-Type"] = "application/json-patch+json"
    
    response = requests.patch(
        url,
        auth=auth,
        headers=headers,
        json=patch_document,
        timeout=30
    )
    return response


# ==================== TFS TASK CREATION HELPER FUNCTIONS ====================

def parse_date_flexible(value) -> datetime:
    """
    Parse date in multiple formats
    
    Supports: dd-MMM-yyyy, dd-MMMM-yyyy, dd-mm-yyyy, dd/mm/yyyy, 
              mm/dd/yyyy, yyyy-mm-dd, and variants
    
    Args:
        value: Date string, datetime object, or None
        
    Returns:
        datetime object or None if parsing fails
    """
    if pd.isna(value) or str(value).strip() == "":
        return None
    
    if isinstance(value, datetime):
        return value
    
    try:
        ts = pd.to_datetime(value, errors="coerce")
        if pd.notna(ts):
            return ts.to_pydatetime()
    except:
        pass
    
    text = str(value).strip()
    formats = [
        "%d-%b-%Y",
        "%d-%B-%Y",
        "%d-%m-%Y",
        "%d/%m/%Y",
        "%m/%d/%Y",
        "%Y-%m-%d",
        "%d-%b-%y",
        "%d-%B-%y",
        "%d-%m-%y",
        "%d/%m/%y",
        "%m/%d/%y",
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    
    return None


def to_tfs_date(value, end_of_day: bool = False) -> str:
    """
    Convert date to TFS ISO 8601 format
    
    Args:
        value: Date string, datetime, or None
        end_of_day: If True, set to 18:00 (end of workday), else 00:00
        
    Returns:
        ISO 8601 format string (e.g., "2025-01-20T00:00:00Z") or None
    """
    dt = parse_date_flexible(value)
    if not dt:
        return None
    
    if end_of_day:
        dt = dt.replace(hour=18, minute=0, second=0, microsecond=0)
    else:
        dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_tfs_identity(email: str, domain: str = "DGSL", base_url: str = None, pat: str = None, username: str = None, password: str = None) -> str:
    """
    Convert email/name to TFS identity format.
    If a partial name is provided, searches TFS for matching identities.
    
    Args:
        email: Email address or name (e.g., "suraj.yadav@company.com", "Utkarsh", "Suraj")
        domain: TFS domain (e.g., "DGSL")
        base_url: TFS base URL for searching identities
        pat: PAT token for TFS search
        username: TFS username for TFS search
        password: TFS password for TFS search
        
    Returns:
        TFS identity in exact format that TFS recognizes (e.g., "Suraj Yadav <...>" or matched identity)
    """
    if not email:
        return None
    
    email = str(email).strip()
    if not email:
        return None
    
    # If it's already a full email, return it as-is. TFS handles emails perfectly.
    if "@" in email and "." in email:
        return email
    
    # It's a name - try to search TFS for exact match first
    name = email.strip()
    
    # Try to search TFS for identities that match this name
    if base_url or pat or (username and password):
        try:
            matches = search_tfs_identities(name, base_url, pat, username, password)
            if matches:
                # Return the best match from TFS
                # Prefer matches that contain the name more accurately
                for match in matches:
                    if name.lower() in match.lower():
                        return match
                return matches[0]
        except Exception as e:
            logging.getLogger(__name__).debug(f"Identity search error for '{name}': {e}")
    
    # Fallback: If it's a single word, maybe it's a username. 
    # But if the user already got "unknown identity" with DOMAIN\name, 
    # we should try just the name as-is (maybe it's a display name).
    if "\\" in name:
        return name
        
    # Last resort fallback logic
    # If we have a domain and the name is short, try domain\name
    # Otherwise just return the name as-is.
    if domain and " " not in name and len(name) < 20:
        # We'll return the domain\name but if it fails, the user should use email.
        return f"{domain}\\{name}"
    
    return name


def extract_project_name(url_value: str) -> str:
    """
    Extract project name from a TFS URL.
    """
    value = (url_value or "").strip()
    if not value:
        return None
    try:
        parsed = urlparse(value)
        # Remove trailing slashes and split
        path = parsed.path.strip("/")
        parts = [p for p in path.split("/") if p]

        # Standard TFS URL: http://server:8080/tfs/Collection/Project
        tfs_idx = -1
        for i, p in enumerate(parts):
            if p.lower() == 'tfs':
                tfs_idx = i
                break
        
        if tfs_idx != -1:
            if len(parts) > tfs_idx + 2:
                # We have /tfs/Collection/Project/...
                project = parts[tfs_idx + 2]
                if not project.startswith("_"):
                    return project
            elif len(parts) > tfs_idx + 1:
                # We only have /tfs/Collection
                # In this case, we can't be sure of the project name
                return None
        
        # If no /tfs/ or we couldn't find a project part after /tfs/Collection
        # Try to look for common patterns
        if parts:
            # Last part if it's not a system part
            last = parts[-1]
            if not last.startswith("_") and last.lower() != 'tfs':
                return last
                
    except Exception:
        pass
    return "TruDocs"


def extract_base_url_and_project(url_value: str):
    """
    Given any TFS/Azure DevOps URL (task URL, work item URL, etc.),
    extract the collection base_url and project name.
    Returns (base_url, project_name) or (None, None) if parsing fails.

    Examples:
      https://server/tfs/Collection/Project/_workitems/edit/1
        -> ("https://server/tfs/Collection", "Project")
      https://dev.azure.com/org/Project/_workitems/edit/1
        -> ("https://dev.azure.com/org", "Project")
    """
    value = (url_value or "").strip().rstrip("/")
    if not value:
        return None, None
    try:
        parsed = urlparse(value)
        path = parsed.path.strip("/")
        parts = [p for p in path.split("/") if p]

        # Find first path segment starting with '_' (system segments like _workitems, _git, _boards)
        sys_idx = next((i for i, p in enumerate(parts) if p.startswith("_")), len(parts))

        # Check for /tfs/ pattern: scheme://host/tfs/Collection/Project/...
        tfs_idx = next((i for i, p in enumerate(parts) if p.lower() == "tfs"), -1)

        if tfs_idx >= 0 and len(parts) > tfs_idx + 2:
            collection = parts[tfs_idx + 1]
            project = parts[tfs_idx + 2]
            base_url = f"{parsed.scheme}://{parsed.netloc}/tfs/{collection}"
            return base_url, project

        # Azure DevOps / no /tfs/: scheme://host/org/Project/...  or  scheme://host/Project/...
        if sys_idx >= 2:
            project = parts[sys_idx - 1]
            collection_parts = parts[:sys_idx - 1]
            base_url = f"{parsed.scheme}://{parsed.netloc}/" + "/".join(collection_parts)
            return base_url, project
        elif sys_idx == 1:
            project = parts[0]
            base_url = f"{parsed.scheme}://{parsed.netloc}"
            return base_url, project
        elif sys_idx == len(parts) and len(parts) >= 2:
            # No system segment found — treat last part as project, rest as base
            project = parts[-1]
            base_url = f"{parsed.scheme}://{parsed.netloc}/" + "/".join(parts[:-1])
            return base_url, project

    except Exception:
        pass
    return None, None


def get_current_user(base_url: str = None, username: str = None, password: str = None, pat: str = None) -> dict:
    """Fetch current authenticated user details from TFS."""
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        return {"success": False, "error": "Missing TFS base URL"}

    try:
        # Try to get collection base for connectionData
        collection_base, _ = _split_collection_and_project(url_base)
        if not collection_base:
            collection_base = url_base

        url = f"{collection_base}/_apis/connectionData?api-version=6.0"
        auth, headers = _get_auth_and_headers(username, password, pat)

        response = requests.get(url, auth=auth, headers=headers, timeout=15)
        if response.status_code == 200:
            data = response.json()
            authenticated_user = data.get("authenticatedUser", {})
            return {
                "success": True,
                "id": authenticated_user.get("uniqueName") or authenticated_user.get("id"),
                "display_name": authenticated_user.get("displayName"),
                "email": authenticated_user.get("properties", {}).get("Mail", {}).get("$value") or ""
            }
        return {"success": False, "error": f"TFS returned status {response.status_code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def search_tfs_identities(name_query: str, base_url: str = None, pat: str = None, username: str = None, password: str = None) -> list[str]:
    """
    Search for TFS identities matching a name query using proper Identities API.
    """
    if not name_query or not name_query.strip():
        return []

    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        return []

    try:
        auth, headers = _get_auth_and_headers(username=username, password=password, pat=pat)
        
        # Use collection base for Identities API (it's collection-level only)
        collection_base, _ = _split_collection_and_project(url_base)
        if not collection_base:
            collection_base = url_base

        # Use proper identity search API if possible
        # Format: /_apis/identities?searchFilter=general&filterValue={query}&api-version=6.0
        search_url = f"{collection_base}/_apis/identities?searchFilter=general&filterValue={requests.utils.quote(name_query)}&queryMembership=none&api-version=6.0"

        response = requests.get(search_url, auth=auth, headers=headers, timeout=10)

        if response.status_code == 200:
            data = response.json()
            identities = []
            for item in data.get("value", []):
                display_name = item.get("displayName")
                mail = item.get("mailAddress") or item.get("uniqueName")

                if display_name:
                    if mail and "@" in mail:
                        identities.append(f"{display_name} <{mail}>")
                    else:
                        identities.append(display_name)

            if identities:
                return identities[:15]

        # Fallback to WIQL if identity API fails
        # For WIQL, project-scoped URL is fine
        wiql_url = f"{url_base}/_apis/wit/wiql?api-version=6.0"
        wiql_body = {
            "query": f"SELECT [System.Id], [System.AssignedTo] FROM WorkItems WHERE [System.AssignedTo] CONTAINS '{name_query}' ORDER BY [System.ChangedDate] DESC"
        }

        response = requests.post(wiql_url, auth=auth, headers=headers, json=wiql_body, timeout=10)
        if response.status_code == 200:
            data = response.json()
            seen = set()
            matched = []
            
            # Use collection_base for individual work item fetches to be safe
            for workitem in data.get("workItems", [])[:50]:
                item_url = f"{collection_base}/_apis/wit/workitems/{workitem['id']}?fields=System.AssignedTo&api-version=6.0"
                item_res = requests.get(item_url, auth=auth, headers=headers, timeout=5)
                if item_res.status_code == 200:
                    user = item_res.json().get("fields", {}).get("System.AssignedTo")
                    if isinstance(user, dict): user = user.get("displayName")
                    if user and user not in seen:
                        seen.add(user)
                        matched.append(user)
            return matched[:10]

    except Exception as e:
        logging.getLogger(__name__).debug(f"TFS identity search failed: {e}")

    return []

def find_existing_task(
    title: str,
    assigned_to: str,
    start_date: str,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    project_name: str = "TruDocs"
) -> int:
    """
    Find existing task using WIQL query to prevent duplicates
    
    Args:
        title: Task title to search
        assigned_to: TFS identity (e.g., "DGSL\\suraj")
        start_date: ISO 8601 date (e.g., "2025-01-20T00:00:00Z")
        base_url: Override default base URL
        pat: Override default PAT token
        project_name: TFS project name
        
    Returns:
        Task ID if found, None otherwise
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    token = pat
    
    if not url_base:
        return None
    
    try:
        start_dt = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
        next_dt = start_dt + timedelta(days=1)
    except:
        return None
    
    def escape_wiql(value):
        return str(value).replace("'", "''")
    
    where_clauses = [
        f"[System.TeamProject] = '{escape_wiql(project_name)}'",
        "[System.WorkItemType] = 'Task'",
        f"[System.Title] = '{escape_wiql(title)}'",
        f"[Microsoft.VSTS.Scheduling.StartDate] >= '{start_dt.isoformat()}'",
        f"[Microsoft.VSTS.Scheduling.StartDate] < '{next_dt.isoformat()}'",
    ]
    
    if assigned_to:
        where_clauses.append(f"[System.AssignedTo] = '{escape_wiql(assigned_to)}'")
    
    query = "SELECT [System.Id] FROM WorkItems WHERE " + " AND ".join(where_clauses)
    
    url = f"{url_base}/_apis/wit/wiql?api-version=6.0"
    auth, headers = _get_auth_and_headers(username=username, password=password, pat=token)
    headers = headers.copy() if headers else {}
    headers["Content-Type"] = "application/json"
    
    try:
        response = requests.post(
            url,
            headers=headers,
            auth=auth,
            json={"query": query},
            timeout=30,
        )
        if (
            response.status_code == 401
            and username
            and password
            and not token
        ):
            for user_try in _username_variants(username, domain):
                retry_auth, retry_headers = _get_auth_and_headers(
                    username=user_try,
                    password=password,
                    pat=None,
                )
                retry_headers = (retry_headers or {}).copy()
                retry_headers["Content-Type"] = "application/json"
                response = requests.post(
                    url,
                    headers=retry_headers,
                    auth=retry_auth,
                    json={"query": query},
                    timeout=30,
                )
                if response.status_code != 401:
                    break
                retry_headers = retry_headers.copy()
                retry_headers.update(_basic_auth_header(user_try, password))
                response = requests.post(
                    url,
                    headers=retry_headers,
                    auth=None,
                    json={"query": query},
                    timeout=30,
                )
                if response.status_code != 401:
                    break
        response.raise_for_status()
        
        data = response.json()
        work_items = data.get("workItems", [])
        if work_items:
            return work_items[0].get("id")
    except Exception as e:
        print(f"Warning: Duplicate check failed: {e}")
    
    return None


def create_task(
    title: str,
    assigned_to: str = None,
    start_date: str = None,
    finish_date: str = None,
    original_estimate: float = None,
    iteration_path: str = None,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    validate_only: bool = False,
    project_name: str = "TruDocs"
) -> requests.Response:
    """
    Create a TFS task with scheduling fields
    
    Args:
        title: Task title (required)
        assigned_to: TFS identity (e.g., "DGSL\\suraj")
        start_date: ISO 8601 format (e.g., "2025-01-20T00:00:00Z")
        finish_date: ISO 8601 format
        original_estimate: Hours (float)
        iteration_path: TFS iteration path
        base_url: Override default base URL
        pat: Override default PAT token
        project_name: TFS project name
        
    Returns:
        TFS API response object
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    token = pat
    
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    if not title:
        raise ValueError("Task title is required")
    
    url = f"{url_base}/_apis/wit/workitems/$Task?api-version=6.1-preview"
    if validate_only:
        url += "&validateOnly=true"
    
    patch_document = [{"op": "add", "path": "/fields/System.Title", "value": title}]
    
    if assigned_to:
        patch_document.append({
            "op": "add",
            "path": "/fields/System.AssignedTo",
            "value": assigned_to,
        })
    
    if iteration_path:
        patch_document.append({
            "op": "add",
            "path": "/fields/System.IterationPath",
            "value": iteration_path,
        })
    
    if start_date:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Scheduling.StartDate",
            "value": start_date,
        })
    
    if finish_date:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Scheduling.FinishDate",
            "value": finish_date,
        })
    
    if original_estimate is not None:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate",
            "value": original_estimate,
        })
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork",
            "value": original_estimate,
        })
    
    auth, headers = _get_auth_and_headers(username=username, password=password, pat=token)
    headers = headers.copy() if headers else {}
    headers["Content-Type"] = "application/json-patch+json"
    
    response = requests.post(
        url,
        headers=headers,
        auth=auth,
        json=patch_document,
        timeout=30,
    )
    
    # AUTO-RETRY FALLBACK: If 400 error (Invalid tree name), try again WITHOUT AreaPath/IterationPath
    if response.status_code == 400 and "TF401347" in response.text:
        filtered_patch = [op for op in patch_document if op.get("path") not in ["/fields/System.AreaPath", "/fields/System.IterationPath"]]
        response = requests.post(url, headers=headers, auth=auth, json=filtered_patch, timeout=30)

    if (
        response.status_code == 401
        and username
        and password
        and not token
    ):
        for user_try in _username_variants(username, domain):
            retry_auth, retry_headers = _get_auth_and_headers(
                username=user_try,
                password=password,
                pat=None,
            )
            retry_headers = (retry_headers or {}).copy()
            retry_headers["Content-Type"] = "application/json-patch+json"
            response = requests.post(
                url,
                headers=retry_headers,
                auth=retry_auth,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
            retry_headers = retry_headers.copy()
            retry_headers.update(_basic_auth_header(user_try, password))
            response = requests.post(
                url,
                headers=retry_headers,
                auth=None,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
    
    return response


def markdown_to_tfs_html(text: str) -> str:
    """
    Convert simple markdown (bold, newlines, images) to TFS-compatible HTML.
    """
    if not text:
        return ""
    
    # Normalize "Text**" (trailing ** only, e.g. "Business Value**") to proper **Text** bold format
    text = re.sub(r'^([^*\n]+)\*\*\s*$', r'**\1**', text, flags=re.MULTILINE)
    
    # Replace **bold** with <b>bold</b>
    html = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', text)
    
    # Replace ![alt](url) with <img src="url" alt="alt"/>
    html = re.sub(r'!\[(.*?)\]\((.*?)\)', r'<img src="\2" alt="\1"/><br/>', html)
    
    # Add extra blank line before section headers (<b>...</b> at start of line) for spacing
    html = re.sub(r'\n(<b>)', r'\n\n\1', html)
    
    # Replace double newlines with paragraph break
    html = html.replace('\n\n', '<br/><br/>')
    # Replace remaining single newlines with line break
    html = html.replace('\n', '<br/>')
    
    return html


def create_work_item(
    work_item_type: str,
    title: str,
    description: str = None,
    reproduction_steps: str = None,
    severity: str = None,
    priority: str = None,
    assigned_to: str = None,
    iteration_path: str = None,
    area_path: str = None,
    related_work_item_id: int = None,
    tags: str = None,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    validate_only: bool = False,
    project_name: str = "TruDocs"
) -> requests.Response:
    """
    Generic function to create any TFS work item type (Bug, Feature, Task, etc.)
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    token = pat
    
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    if not title:
        raise ValueError("Work item title is required")
        
    wit_type = work_item_type.strip().capitalize()
    
    # Check if project name is already in url_base
    url_parts = url_base.rstrip('/').split('/')
    last_part = url_parts[-1]
    
    # If the last part is not the project name, add it
    current_url = url_base
    if project_name and last_part.lower() != project_name.lower() and last_part.lower() != 'tfs':
        current_url = f"{url_base}/{project_name}"
    
    url = f"{current_url}/_apis/wit/workitems/${wit_type}?api-version=6.1-preview"
    if validate_only:
        url += "&validateOnly=true"
    
    patch_document = [{"op": "add", "path": "/fields/System.Title", "value": title}]
    
    # For Bugs, we want to ensure visibility in both Description and ReproSteps areas
    is_bug = (wit_type.lower() == "bug" if 'wit_type' in locals() else True)
    
    actual_description = description or (reproduction_steps if is_bug else "")
    actual_repro = reproduction_steps or (description if is_bug else "")

    if actual_description:
        html_description = markdown_to_tfs_html(str(actual_description))
        patch_document.append({"op": "add", "path": "/fields/System.Description", "value": html_description})
    
    if is_bug and actual_repro:
        html_repro = markdown_to_tfs_html(str(actual_repro))
        patch_document.append({"op": "add", "path": "/fields/Microsoft.VSTS.TCM.ReproSteps", "value": html_repro})
    
    # Add Severity and Priority fields (independent of ReproSteps)
    if is_bug and severity:
        patch_document.append({"op": "add", "path": "/fields/Microsoft.VSTS.Common.Severity", "value": severity})
    
    if priority:
        patch_document.append({"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": priority})
    
    if wit_type == "Feature":
        pass
    
    if assigned_to:
        patch_document.append({"op": "add", "path": "/fields/System.AssignedTo", "value": assigned_to})
    
    # Robust Path Formatting: TFS AreaPath/IterationPath usually should start with ProjectName
    if iteration_path and str(iteration_path).strip():
        val = str(iteration_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass 
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.IterationPath", "value": val})
    
    if area_path and str(area_path).strip():
        val = str(area_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.AreaPath", "value": val})
        
    if related_work_item_id:
        patch_document.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Related",
                "url": f"{url_base}/_apis/wit/workitems/{related_work_item_id}"
            }
        })
        
    if tags:
        tfs_tags = tags.replace(',', ';')
        patch_document.append({"op": "add", "path": "/fields/System.Tags", "value": tfs_tags})
        
    # DEBUG: Log patch document to see what's being sent
    try:
        import logging
        logger = logging.getLogger("tfs_tool")
        
        # Check what fields are in the patch
        field_paths = [op.get('path', '') for op in patch_document]
        has_title = any('System.Title' in p for p in field_paths)
        has_desc = any('System.Description' in p for p in field_paths)
        has_repro = any('ReproSteps' in p for p in field_paths)
        
        logger.info(f"=== PATCH DOCUMENT DEBUG ===")
        logger.info(f"Work Item Type: {wit_type}, Has Title: {has_title}, Has Description: {has_desc}, Has ReproSteps: {has_repro}")
        logger.info(f"Full patch_document: {json.dumps(patch_document)}")
        
        if has_desc:
            desc_ops = [op for op in patch_document if 'System.Description' in op.get('path', '')]
            logger.info(f"Description content length: {len(desc_ops[0].get('value', '')) if desc_ops else 0}")
    except Exception as e:
        print(f"DEBUG: Error logging patch: {e}")
        print(f"DEBUG: patch_document for {wit_type}: {patch_document}")

    auth, headers = _get_auth_and_headers(username=username, password=password, pat=token)
    headers = (headers or {}).copy()
    headers["Content-Type"] = "application/json-patch+json"
    
    response = requests.post(url, headers=headers, auth=auth, json=patch_document, timeout=30)
    
    # AUTO-RETRY FALLBACK: If 400 error (Invalid tree name), try again WITHOUT AreaPath/IterationPath
    if response.status_code == 400 and "TF401347" in response.text:
        logging.getLogger("tfs_tool").warning("TFS returned 400 (Invalid tree name). Retrying without AreaPath/IterationPath fallback...")
        filtered_patch = [op for op in patch_document if op.get("path") not in ["/fields/System.AreaPath", "/fields/System.IterationPath"]]
        response = requests.post(url, headers=headers, auth=auth, json=filtered_patch, timeout=30)

    if response.status_code == 401 and username and password and not token:
        # (existing retry logic)
        for user_try in _username_variants(username, domain):
            retry_auth, retry_headers = _get_auth_and_headers(username=user_try, password=password)
            retry_headers = (retry_headers or {}).copy()
            retry_headers["Content-Type"] = "application/json-patch+json"
            response = requests.post(url, headers=retry_headers, auth=retry_auth, json=patch_document, timeout=30)
            if response.status_code != 401: break
            
    return response

def fetch_work_item_details(
    work_item_id: int,
    base_url: str = None,
    username: str = None,
    password: str = None,
    pat: str = None,
) -> dict:
    """
    Fetch any work item details from TFS by ID
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    url = f"{url_base}/_apis/wit/workitems/{work_item_id}?api-version=6.0"
    
    auth, headers = _get_auth_and_headers(username, password, pat)
    
    response = requests.get(url, auth=auth, headers=headers, timeout=15)
    response.raise_for_status()
    
    data = response.json()
    fields = data.get("fields", {})
    wi_type = fields.get("System.WorkItemType", "")
    
    # Extract HTML fields and convert to plain text
    html_description = fields.get("System.Description", "") or ""
    html_repro_steps = fields.get("Microsoft.VSTS.TCM.ReproSteps", "") or ""
    
    description = ""
    if html_description:
        soup = BeautifulSoup(html_description, "html.parser")
        description = soup.get_text().strip()
    
    repro_steps = ""
    if html_repro_steps:
        soup_repro = BeautifulSoup(html_repro_steps, "html.parser")
        repro_steps = soup_repro.get_text().strip()
    
    assigned_to = fields.get("System.AssignedTo", "")
    if isinstance(assigned_to, dict):
        assigned_to = assigned_to.get("displayName") or assigned_to.get("uniqueName") or ""

    return {
        "id": work_item_id,
        "title": fields.get("System.Title", ""),
        "description": description,
        "reproduction_steps": repro_steps,
        "priority": str(fields.get("Microsoft.VSTS.Common.Priority", "2")),
        "severity": fields.get("Microsoft.VSTS.Common.Severity", "2 - High"),
        "assigned_to": str(assigned_to),
        "iteration_path": fields.get("System.IterationPath", ""),
        "area_path": fields.get("System.AreaPath", ""),
        "tags": fields.get("System.Tags", ""),
        "state": fields.get("System.State", ""),
        "work_item_type": wi_type,
    }



def update_task(
    task_id: int,
    title: str = None,
    assigned_to: str = None,
    start_date: str = None,
    finish_date: str = None,
    original_estimate: float = None,
    iteration_path: str = None,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    project_name: str = "TruDocs",
    related_work_item_id: int = None
) -> requests.Response:
    """
    Update an existing TFS task work item
    
    Args:
        task_id: Work item ID to update
        title: Task title
        assigned_to: TFS identity (e.g., "DGSL\\developer")
        start_date: Start date (ISO format)
        finish_date: Finish date (ISO format)
        original_estimate: Hours estimate
        iteration_path: TFS iteration path
        base_url: Override default base URL
        pat: Override default PAT token
        project_name: TFS project name
        
    Returns:
        TFS API response object
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    token = pat
    
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    if not task_id:
        raise ValueError("Task ID is required")
    
    url = f"{url_base}/_apis/wit/workitems/{task_id}?api-version=6.1-preview"
    
    patch_document = []
    
    if title:
        patch_document.append({"op": "replace", "path": "/fields/System.Title", "value": title})
    
    if assigned_to:
        patch_document.append({
            "op": "replace",
            "path": "/fields/System.AssignedTo",
            "value": assigned_to,
        })
    
    if iteration_path:
        patch_document.append({
            "op": "replace",
            "path": "/fields/System.IterationPath",
            "value": iteration_path,
        })
    
    if start_date:
        patch_document.append({
            "op": "replace",
            "path": "/fields/Microsoft.VSTS.Scheduling.StartDate",
            "value": start_date,
        })
    
    if finish_date:
        patch_document.append({
            "op": "replace",
            "path": "/fields/Microsoft.VSTS.Scheduling.FinishDate",
            "value": finish_date,
        })
    
    if original_estimate is not None:
        patch_document.append({
            "op": "replace",
            "path": "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate",
            "value": original_estimate,
        })
        patch_document.append({
            "op": "replace",
            "path": "/fields/Microsoft.VSTS.Scheduling.RemainingWork",
            "value": original_estimate,
        })
    
    if related_work_item_id:
        patch_document.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Related",
                "url": f"{url_base}/_apis/wit/workitems/{related_work_item_id}"
            }
        })
    
    if not patch_document:
        return None  # Nothing to update
    
    auth, headers = _get_auth_and_headers(username=username, password=password, pat=token)
    headers = headers.copy() if headers else {}
    headers["Content-Type"] = "application/json-patch+json"
    
    try:
        response = requests.patch(
            url,
            headers=headers,
            auth=auth,
            json=patch_document,
            timeout=30,
        )
        return response
    except requests.exceptions.Timeout:
        # Return a mock response object with timeout info
        class TimeoutResponse:
            status_code = 504
            text = "Request timeout (30s)"
        return TimeoutResponse()
    except requests.exceptions.ConnectionError as e:
        class ConnErrorResponse:
            status_code = 503
            text = f"Connection error: {str(e)[:100]}"
        return ConnErrorResponse()
    except Exception as e:
        class ErrorResponse:
            status_code = 500
            text = f"Request failed: {str(e)[:100]}"
        return ErrorResponse()


def create_bug(
    title: str,
    description: str = None,
    reproduction_steps: str = None,
    severity: str = "2 - High",
    priority: str = "1",
    assigned_to: str = None,
    iteration_path: str = None,
    area_path: str = None,
    related_work_item_id: int = None,
    tags: str = None,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    validate_only: bool = False,
    project_name: str = "TruDocs"
) -> requests.Response:
    """
    Create a TFS bug work item
    
    Args:
        title: Bug title (required)
        description: Bug description
        reproduction_steps: Steps to reproduce the bug
        severity: Bug severity (1 - Critical, 2 - High, 3 - Medium, 4 - Low)
        priority: Bug priority (1 - High, 2 - Normal, 3 - Low)
        assigned_to: TFS identity (e.g., "DGSL\\developer")
        iteration_path: TFS iteration path
        area_path: TFS area path
        related_work_item_id: Related story or test case ID to link
        tags: Comma-separated tags
        base_url: Override default base URL
        pat: Override default PAT token
        project_name: TFS project name
        
    Returns:
        TFS API response object
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    token = pat
    
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    if not title:
        raise ValueError("Bug title is required")
    
    # Check if project name is already in url_base
    url_parts = url_base.rstrip('/').split('/')
    last_part = url_parts[-1]
    
    # If the last part is not the project name, add it
    current_url = url_base
    if project_name and last_part.lower() != project_name.lower() and last_part.lower() != 'tfs':
        current_url = f"{url_base}/{project_name}"
    
    url = f"{current_url}/_apis/wit/workitems/$Bug?api-version=6.1-preview"
    if validate_only:
        url += "&validateOnly=true"
    
    patch_document = [{"op": "add", "path": "/fields/System.Title", "value": title}]
    
    if description:
        html_description = markdown_to_tfs_html(description)
        patch_document.append({
            "op": "add",
            "path": "/fields/System.Description",
            "value": html_description,
        })
    
    if reproduction_steps:
        # Convert markdown and newlines to HTML for TFS ReproSteps field
        html_repro_steps = markdown_to_tfs_html(reproduction_steps)
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.TCM.ReproSteps",
            "value": html_repro_steps,
        })
    
    if severity:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Common.Severity",
            "value": severity,
        })
    
    if priority:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Common.Priority",
            "value": priority,
        })
    
    if assigned_to:
        patch_document.append({
            "op": "add",
            "path": "/fields/System.AssignedTo",
            "value": assigned_to,
        })
    
    # Robust Path Formatting: TFS AreaPath/IterationPath usually should start with ProjectName
    if iteration_path and str(iteration_path).strip():
        val = str(iteration_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass 
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.IterationPath", "value": val})
    
    if area_path and str(area_path).strip():
        val = str(area_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.AreaPath", "value": val})
    
    if related_work_item_id:
        patch_document.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Related",
                "url": f"{url_base}/_apis/wit/workitems/{related_work_item_id}"
            }
        })
    
    if tags:
        # TFS tags field expects a string with semicolon-separated tags
        # Convert comma-separated to semicolon-separated and clean up
        tag_list = [tag.strip() for tag in tags.split(',') if tag.strip()]
        tfs_tags = ';'.join(tag_list)
        if tfs_tags:
            patch_document.append({
                "op": "add",
                "path": "/fields/System.Tags",
                "value": tfs_tags,
            })
    
    auth, headers = _get_auth_and_headers(username=username, password=password, pat=token)
    headers = headers.copy() if headers else {}
    headers["Content-Type"] = "application/json-patch+json"
    
    response = requests.post(
        url,
        headers=headers,
        auth=auth,
        json=patch_document,
        timeout=30,
    )
    
    # AUTO-RETRY FALLBACK: If 400 error (Invalid tree name), try again WITHOUT AreaPath/IterationPath
    if response.status_code == 400 and "TF401347" in response.text:
        filtered_patch = [op for op in patch_document if op.get("path") not in ["/fields/System.AreaPath", "/fields/System.IterationPath"]]
        response = requests.post(url, headers=headers, auth=auth, json=filtered_patch, timeout=30)

    if (
        response.status_code == 401
        and username
        and password
        and not token
    ):
        for user_try in _username_variants(username, domain):
            retry_auth, retry_headers = _get_auth_and_headers(
                username=user_try,
                password=password,
                pat=None,
            )
            retry_headers = (retry_headers or {}).copy()
            retry_headers["Content-Type"] = "application/json-patch+json"
            response = requests.post(
                url,
                headers=retry_headers,
                auth=retry_auth,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
            retry_headers = retry_headers.copy()
            retry_headers.update(_basic_auth_header(user_try, password))
            response = requests.post(
                url,
                headers=retry_headers,
                auth=None,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
    
    return response


def fetch_bug_details(
    bug_id: int,
    base_url: str = None,
    username: str = None,
    password: str = None,
    pat: str = None,
) -> dict:
    """
    Fetch bug details from TFS by bug ID
    
    Args:
        bug_id: Bug work item ID
        base_url: TFS base URL
        username: TFS username
        password: TFS password
        pat: Personal Access Token
        
    Returns:
        Dict with bug details
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    # Fetch with relations to get story links
    url = f"{url_base}/_apis/wit/workitems/{bug_id}?api-version=6.0&$expand=Relations"
    
    auth, headers = _get_auth_and_headers(username, password, pat)
    
    response = requests.get(url, auth=auth, headers=headers, timeout=15)
    response.raise_for_status()
    
    data = response.json()
    fields = data.get("fields", {})
    
    # Extract HTML fields and convert to readable text preserving structure
    html_description = fields.get("System.Description", "")
    html_repro_steps = fields.get("Microsoft.VSTS.TCM.ReproSteps", "")
    
    description = html_to_text(html_description)
    repro_steps = html_to_text(html_repro_steps)
    
    assigned_to = fields.get("System.AssignedTo", "")
    if isinstance(assigned_to, dict):
        assigned_to = assigned_to.get("displayName") or assigned_to.get("uniqueName") or ""

    # Extract story link ID from relations
    story_link_id = None
    relations = data.get('relations', [])
    for rel in relations:
        if rel.get('rel') == 'System.LinkTypes.Related':
            url_parts = rel.get('url', '').split('/')
            if url_parts:
                try:
                    story_link_id = int(url_parts[-1])
                    break
                except (ValueError, IndexError):
                    pass

    return {
        "id": bug_id,
        "title": fields.get("System.Title", ""),
        "description": description,
        "reproduction_steps": repro_steps,
        "priority": str(fields.get("Microsoft.VSTS.Common.Priority", "2")),
        "severity": fields.get("Microsoft.VSTS.Common.Severity", "2 - High"),
        "assigned_to": str(assigned_to),
        "iteration_path": fields.get("System.IterationPath", ""),
        "area_path": fields.get("System.AreaPath", ""),
        "tags": fields.get("System.Tags", ""),
        "state": fields.get("System.State", ""),
        "work_item_type": fields.get("System.WorkItemType", ""),
        "story_link_id": story_link_id,
    }


def update_bug(
    bug_id: int,
    title: str = None,
    description: str = None,
    reproduction_steps: str = None,
    severity: str = None,
    priority: str = None,
    assigned_to: str = None,
    iteration_path: str = None,
    area_path: str = None,
    tags: str = None,
    state: str = None,
    base_url: str = None,
    pat: str = None,
    username: str = None,
    password: str = None,
    domain: str = None,
    project_name: str = "TruDocs",
    related_work_item_id: int = None
) -> requests.Response:
    """
    Update an existing TFS bug work item
    
    Args:
        bug_id: Bug work item ID to update
        title: New bug title
        description: New bug description
        reproduction_steps: New reproduction steps
        severity: New severity level
        priority: New priority level
        assigned_to: New assigned to user
        iteration_path: New iteration path
        area_path: New area path
        tags: New tags
        state: New state
        base_url: TFS base URL
        pat: Personal Access Token
        username: TFS username
        password: TFS password
        domain: Domain for identity resolution
        project_name: TFS project name
        
    Returns:
        TFS API response object
    """
    url_base = _normalize_tfs_url_for_api(base_url or BASE_URL)
    if not url_base:
        raise ValueError("Missing TFS base URL")
    
    url = f"{url_base}/_apis/wit/workitems/{bug_id}?api-version=6.1-preview"
    token = pat
    
    # Build patch document
    patch_document = []
    
    if title:
        patch_document.append({"op": "add", "path": "/fields/System.Title", "value": title})
    
    # Since this is update_bug, it is always a bug
    is_bug = True
    
    actual_description = description or (reproduction_steps if is_bug else "")
    actual_repro = reproduction_steps or (description if is_bug else "")

    # DEBUG logging
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"=== UPDATE_BUG FIELD ASSEMBLY ===")
    logger.info(f"Bug ID: {bug_id}")
    logger.info(f"description param received: {bool(description)} | length: {len(str(description)) if description else 0}")
    logger.info(f"reproduction_steps param received: {bool(reproduction_steps)} | length: {len(str(reproduction_steps)) if reproduction_steps else 0}")
    logger.info(f"actual_description computed: {bool(actual_description)} | length: {len(str(actual_description)) if actual_description else 0}")
    logger.info(f"actual_repro computed: {bool(actual_repro)} | length: {len(str(actual_repro)) if actual_repro else 0}")

    if actual_description:
        html_description = markdown_to_tfs_html(str(actual_description))
        logger.info(f"Description will be added to patch. HTML length: {len(html_description)}")
        logger.info(f"Description HTML (first 200 chars): {html_description[:200]}")
        # Use "replace" for updating existing fields on work items
        patch_document.append({"op": "replace", "path": "/fields/System.Description", "value": html_description})
    else:
        logger.info(f"Description is EMPTY - will NOT be added to patch")
    
    if actual_repro:
        html_repro = markdown_to_tfs_html(str(actual_repro))
        logger.info(f"ReproSteps will be added to patch. HTML length: {len(html_repro)}")
        # Use "replace" for updating existing fields on work items
        patch_document.append({"op": "replace", "path": "/fields/Microsoft.VSTS.TCM.ReproSteps", "value": html_repro})
    else:
        logger.info(f"ReproSteps is EMPTY - will NOT be added to patch")
    
    if severity is not None:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Common.Severity",
            "value": severity,
        })
    
    if priority is not None:
        patch_document.append({
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Common.Priority",
            "value": priority,
        })
    
    if assigned_to is not None:
        patch_document.append({
            "op": "add",
            "path": "/fields/System.AssignedTo",
            "value": assigned_to,
        })
    
    # Robust Path Formatting: TFS AreaPath/IterationPath usually should start with ProjectName
    if iteration_path and str(iteration_path).strip():
        val = str(iteration_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass 
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.IterationPath", "value": val})
    
    if area_path and str(area_path).strip():
        val = str(area_path).strip().replace('\r', '').replace('\n', '')
        if val:
            # Normalize: Remove all leading \
            val = val.lstrip('\\')
            
            # If val already starts with project_name, don't prefix it
            if project_name and val.lower().startswith(f"{project_name.lower()}\\"):
                pass
            elif project_name and val.lower() == project_name.lower():
                pass
            elif project_name:
                # Prefix it
                val = f"{project_name}\\{val}"
                
            patch_document.append({"op": "add", "path": "/fields/System.AreaPath", "value": val})
    
    if tags is not None:
        # TFS tags field expects semicolon-separated tags
        tag_list = [tag.strip() for tag in tags.split(',') if tag.strip()]
        tfs_tags = ';'.join(tag_list)
        if tfs_tags:
            patch_document.append({
                "op": "add",
                "path": "/fields/System.Tags",
                "value": tfs_tags,
            })

    # Handle story link: First remove old related links, then add new one if provided
    if related_work_item_id:
        try:
            # Fetch current work item to get relations
            fetch_url = f"{url_base}/_apis/wit/workitems/{bug_id}?api-version=6.0&$expand=Relations"
            fetch_response = requests.get(fetch_url, auth=_get_auth_and_headers(username, password, pat)[0], headers=_get_auth_and_headers(username, password, pat)[1] or {}, timeout=15)
            if fetch_response.status_code == 200:
                fetch_data = fetch_response.json()
                relations = fetch_data.get('relations', [])
                # Remove all existing related links (System.LinkTypes.Related)
                for i, rel in enumerate(relations):
                    if rel.get('rel') == 'System.LinkTypes.Related':
                        patch_document.append({
                            "op": "remove",
                            "path": f"/relations/{i}"
                        })
        except Exception:
            # If fetching fails, continue - the new link will still be added
            pass
        
        # Add new related link
        patch_document.append({
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "System.LinkTypes.Related",
                "url": f"{url_base}/_apis/wit/workitems/{related_work_item_id}"
            }
        })
    
    if state is not None:
        patch_document.append({
            "op": "add",
            "path": "/fields/System.State",
            "value": state,
        })
    
    if not patch_document:
        # No fields to update
        return requests.Response()
    
    auth, headers = _get_auth_and_headers(username=username, password=password, pat=pat)
    headers = headers.copy() if headers else {}
    headers["Content-Type"] = "application/json-patch+json"
    
    # Log the patch document being sent
    import json
    logger.info(f"=== PATCH DOCUMENT BEING SENT TO TFS ===")
    logger.info(f"URL: {url}")
    logger.info(f"Patch Operations Count: {len(patch_document)}")
    for i, op in enumerate(patch_document):
        if '/fields/' in op.get('path', ''):
            field_name = op.get('path', '').split('/')[-1]
            logger.info(f"  [{i}] {op['op'].upper()} {field_name} (value length: {len(str(op.get('value', '')))})")
        else:
            logger.info(f"  [{i}] {op}")
    
    response = requests.patch(
        url,
        headers=headers,
        auth=auth,
        json=patch_document,
        timeout=30,
    )
    
    # Log the response
    try:
        logger.info(f"=== UPDATE_BUG TFS RESPONSE ===")
        logger.info(f"Status Code: {response.status_code}")
        response_text = response.text if hasattr(response, 'text') else str(response)
        logger.info(f"Response Length: {len(response_text)}")
        if response.status_code not in [200, 201]:
            logger.error(f"ERROR Response: {response_text[:500]}")
        else:
            logger.info(f"SUCCESS: Work item updated")
            try:
                resp_data = response.json()
                logger.info(f"Updated work item ID: {resp_data.get('id')}")
                # Log the fields that were updated
                if 'fields' in resp_data:
                    fields = resp_data['fields']
                    if 'System.Description' in fields:
                        desc_value = fields['System.Description']
                        logger.info(f"System.Description in response: {len(str(desc_value)) if desc_value else 0} chars")
                        logger.info(f"Description value (first 150 chars): {str(desc_value)[:150]}")
                    else:
                        logger.error(f"System.Description NOT in response fields!")
                        logger.info(f"Available fields: {list(fields.keys())[:10]}")
                    
                    if 'Microsoft.VSTS.TCM.ReproSteps' in fields:
                        repro_value = fields['Microsoft.VSTS.TCM.ReproSteps']
                        logger.info(f"Microsoft.VSTS.TCM.ReproSteps in response: {len(str(repro_value)) if repro_value else 0} chars")
                    else:
                        logger.warning(f"Microsoft.VSTS.TCM.ReproSteps NOT in response")
            except Exception as e:
                logger.warning(f"Could not parse response JSON: {e}")
    except Exception as e:
        logger.warning(f"Could not log response details: {e}")
    
    # CRITICAL DEBUG: Verify description was actually set by fetching the work item again
    if response.status_code in [200, 201]:
        try:
            logger.info(f"=== VERIFICATION: Fetching work item again to verify update ===")
            verify_url = f"{url_base}/_apis/wit/workitems/{bug_id}?api-version=6.1"
            verify_response = requests.get(verify_url, auth=auth, headers={"Content-Type": "application/json"}, timeout=30)
            if verify_response.status_code == 200:
                verify_data = verify_response.json()
                verify_fields = verify_data.get('fields', {})
                actual_desc = verify_fields.get('System.Description', '')
                logger.info(f"After update - Description length in work item: {len(str(actual_desc)) if actual_desc else 0} chars")
                if actual_desc:
                    logger.info(f"Description value (first 150 chars): {str(actual_desc)[:150]}")
                else:
                    logger.error(f"CRITICAL: Description is EMPTY after update! Value: {actual_desc}")
            else:
                logger.error(f"Could not verify - fetch returned status {verify_response.status_code}")
        except Exception as e:
            logger.error(f"Verification failed: {e}")
    
    # Retry with username variants if 401
    if (
        response.status_code == 401
        and username
        and password
        and not pat
    ):
        for user_try in _username_variants(username, domain):
            retry_auth, retry_headers = _get_auth_and_headers(
                username=user_try,
                password=password,
                pat=None,
            )
            retry_headers = (retry_headers or {}).copy()
            retry_headers["Content-Type"] = "application/json-patch+json"
            response = requests.patch(
                url,
                headers=retry_headers,
                auth=retry_auth,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
            retry_headers = retry_headers.copy()
            retry_headers.update(_basic_auth_header(user_try, password))
            response = requests.patch(
                url,
                headers=retry_headers,
                auth=None,
                json=patch_document,
                timeout=30,
            )
            if response.status_code != 401:
                break
    
    return response


def fetch_test_plans(
    collection_url: str,
    project: str = None,
    username: str = "",
    password: str = "",
    pat: str = ""
) -> list:
    """
    Fetch available test plans for a given project.
    Returns a list of plan dictionaries with id, name, and description.
    """
    logger = logging.getLogger(__name__)
    
    logger.info(f"🔍 FETCH_TEST_PLANS CALLED: project={project}")
    plans = []
    
    # Extract project from collection_url if not provided
    if not project and collection_url:
        try:
            parsed = urlparse(collection_url)
            parts = [p for p in parsed.path.split("/") if p]
            logger.info(f"📋 Parsed path parts: {parts}")
            # Format: /tfs/CollectionName/ProjectName or /CollectionName/ProjectName
            if len(parts) >= 2:
                if parts[0].lower() == "tfs" and len(parts) >= 3:
                    project = parts[2]
                    logger.info(f"✅ Extracted project from TFS path: {project}")
                elif len(parts) >= 2:
                    # /Collection/Project format
                    project = parts[-1]
                    logger.info(f"✅ Extracted project from path: {project}")
        except Exception as e:
            logger.error(f"❌ Failed to extract project from URL: {str(e)}")
    
    if not project:
        logger.error("❌ Project could not be determined from collection_url or request")
        return []
    
    logger.info(f"✅ Using project: {project}")
    
    # Get auth
    auth_obj = None
    headers = {}
    if pat:
        import base64
        token = base64.b64encode(f":{pat}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
        logger.info("✅ Using PAT authentication")
    elif username and password:
        try:
            from requests_ntlm import HttpNtlmAuth
            auth_obj = HttpNtlmAuth(username, password)
            logger.info(f"✅ Using NTLM authentication with user: {username}")
        except ImportError as ie:
            logger.warning(f"⚠️ HttpNtlmAuth ImportError: {str(ie)}")
    else:
        logger.warning("⚠️ No authentication provided")
    
    try:
        # Fetch available plans
        url = f"{collection_url}/{project}/_apis/test/Plans?api-version=6.0"
        logger.info(f"📤 Fetching available plans: {url}")
        logger.info(f"🔑 Auth type: {'PAT' if pat else ('NTLM' if username else 'None')}")
        
        print(f"\n[FETCH_PLANS DEBUG] URL: {url}", flush=True)
        print(f"[FETCH_PLANS DEBUG] Auth type: {'PAT' if pat else ('NTLM' if username else 'None')}", flush=True)
        
        response = requests.get(url, auth=auth_obj, headers=headers, timeout=60, verify=False)
        logger.info(f"📥 Response status: {response.status_code}")
        print(f"[FETCH_PLANS DEBUG] Response status: {response.status_code}", flush=True)
        
        if response.status_code == 200:
            plans_data = response.json().get("value", [])
            print(f"[FETCH_PLANS DEBUG] Got {len(plans_data)} plans from API", flush=True)
            logger.info(f"✅ Got {len(plans_data)} available plans")
            
            if plans_data:
                for i, plan in enumerate(plans_data[:5]):  # Log first 5 plans
                    logger.info(f"  Plan {i+1}: ID={plan.get('id')}, Name={plan.get('name')}")
            
            for plan in plans_data:
                plans.append({
                    "id": str(plan.get("id", "")),
                    "name": plan.get("name", ""),
                    "description": plan.get("description", ""),
                    "area": plan.get("area", "")
                })
        elif response.status_code == 404:
            # Test Plans REST API not available, try alternative approach
            print(f"[FETCH_PLANS DEBUG] Test/Plans API returned 404, trying work items approach", flush=True)
            logger.warning("📋 Test/Plans API not found, attempting work items query")
            
            # Try querying work items for Test Plans
            # In some TFS versions, test plans might be work items with type "Test Plan"
            wiql_url = f"{collection_url}/{project}/_apis/wit/wiql?api-version=6.0"
            wiql_query = {
                "query": "SELECT [System.Id], [System.Title], [System.Description] FROM WorkItems WHERE [System.WorkItemType] = 'Test Plan' ORDER BY [System.CreatedDate] DESC"
            }
            
            print(f"[FETCH_PLANS DEBUG] Trying WIQL query: {wiql_url}", flush=True)
            logger.info(f"📤 Trying WIQL query: {wiql_url}")
            
            wiql_response = requests.post(wiql_url, json=wiql_query, auth=auth_obj, headers=headers, timeout=60, verify=False)
            logger.info(f"📥 WIQL Response status: {wiql_response.status_code}")
            print(f"[FETCH_PLANS DEBUG] WIQL Response status: {wiql_response.status_code}", flush=True)
            
            if wiql_response.status_code == 200:
                wiql_data = wiql_response.json()
                work_items = wiql_data.get("workItems", [])
                print(f"[FETCH_PLANS DEBUG] Got {len(work_items)} work items from WIQL", flush=True)
                logger.info(f"✅ Got {len(work_items)} test plans via WIQL")
                
                # Extract plan details from work items
                for wi in work_items:
                    plan_id = str(wi.get("id", ""))
                    # Get work item details
                    wi_detail_url = f"{collection_url}/{project}/_apis/wit/workitems/{plan_id}?fields=System.Title,System.Description&api-version=6.0"
                    try:
                        wi_detail = requests.get(wi_detail_url, auth=auth_obj, headers=headers, timeout=20, verify=False).json()
                        plans.append({
                            "id": plan_id,
                            "name": wi_detail.get("fields", {}).get("System.Title", f"Plan {plan_id}"),
                            "description": wi_detail.get("fields", {}).get("System.Description", ""),
                            "area": ""
                        })
                    except Exception as e:
                        logger.warning(f"Could not fetch details for work item {plan_id}: {str(e)}")
                        plans.append({
                            "id": plan_id,
                            "name": f"Plan {plan_id}",
                            "description": "",
                            "area": ""
                        })
            else:
                response_text = wiql_response.text[:500] if wiql_response.text else "No response"
                print(f"[FETCH_PLANS DEBUG] WIQL error: {response_text}", flush=True)
                logger.warning(f"⚠️ WIQL query failed: {wiql_response.status_code}")
        else:
            response_text = response.text[:500] if response.text else "No response body"
            logger.error(f"❌ Failed to fetch plans (status {response.status_code})")
            logger.error(f"📄 Response body: {response_text}")
            print(f"[FETCH_PLANS DEBUG] ERROR Status: {response.status_code}", flush=True)
            print(f"[FETCH_PLANS DEBUG] Response headers: {dict(response.headers)}", flush=True)
            print(f"[FETCH_PLANS DEBUG] Response body: {response_text}", flush=True)
    except Exception as e:
        logger.error(f"❌ Exception fetching plans: {str(e)}", exc_info=True)
        print(f"[FETCH_PLANS DEBUG] EXCEPTION: {str(e)}", flush=True)
        import traceback
        print(f"[FETCH_PLANS DEBUG] Traceback: {traceback.format_exc()}", flush=True)
    
    logger.info(f"✅ Returning {len(plans)} plans")
    return plans


def fetch_test_suites(
    collection_url: str,
    project: str = None,
    plan_id: str = None,
    username: str = "",
    password: str = "",
    pat: str = ""
) -> list:
    """
    Fetch available test suites for a given project and plan.
    Returns a list of suite dictionaries with id, name, and type.
    If project is not provided, tries to extract it from the collection_url.
    """
    logger = logging.getLogger(__name__)
    
    logger.info(f"🔍 FETCH_TEST_SUITES CALLED: project={project}, plan_id={plan_id}")
    suites = []
    
    # Extract project from collection_url if not provided
    if not project and collection_url:
        try:
            parsed = urlparse(collection_url)
            parts = [p for p in parsed.path.split("/") if p]
            logger.info(f"📋 Parsed path parts: {parts}")
            # Format: /tfs/CollectionName/ProjectName or /CollectionName/ProjectName
            if len(parts) >= 2:
                if parts[0].lower() == "tfs" and len(parts) >= 3:
                    project = parts[2]
                    logger.info(f"✅ Extracted project from TFS path: {project}")
                elif len(parts) >= 2:
                    # /Collection/Project format
                    project = parts[-1]
                    logger.info(f"✅ Extracted project from path: {project}")
        except Exception as e:
            logger.error(f"❌ Failed to extract project from URL: {str(e)}")
    
    if not project:
        logger.error("❌ Project could not be determined from collection_url or request")
        return []
    
    logger.info(f"✅ Using project: {project}")
    
    # Get auth
    auth_obj = None
    headers = {}
    if pat:
        import base64
        token = base64.b64encode(f":{pat}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
        logger.info("✅ Using PAT authentication")
    elif username and password:
        try:
            from requests_ntlm import HttpNtlmAuth
            auth_obj = HttpNtlmAuth(username, password)
            logger.info(f"✅ Using NTLM authentication with user: {username}")
        except ImportError as ie:
            logger.warning(f"⚠️ HttpNtlmAuth ImportError: {str(ie)}")
    else:
        logger.warning("⚠️ No authentication provided")
    
    try:
        # Try to fetch from the specific plan first
        if plan_id:
            # Try with expand=children parameter first
            # NOTE: Must use lowercase "plans" not "Plans" and NO api-version per meter
            url = f"{collection_url}/{project}/_apis/test/plans/{plan_id}/suites?$expand=children"
            logger.info(f"📤 Fetching suites from plan {plan_id}: {url}")
            logger.info(f"🔑 Auth type: {'PAT' if pat else ('NTLM' if username else 'None')}")
            
            response = requests.get(url, auth=auth_obj, headers=headers, timeout=30, verify=False)
            logger.info(f"📥 Response status: {response.status_code}")
            print(f"[FETCH_SUITES DEBUG] REST API status: {response.status_code}", flush=True)
            
            if response.status_code == 200:
                try:
                    data = response.json()
                    suites_list = data.get('value', [])
                    logger.info(f"✅ Got {len(suites_list)} suites from REST API for plan {plan_id}")
                    print(f"[FETCH_SUITES DEBUG] Got {len(suites_list)} suites from REST API", flush=True)
                    
                    for suite in suites_list:
                        suites.append({
                            "id": str(suite.get("id", "")),
                            "name": suite.get("name", ""),
                            "type": suite.get("suiteType", ""),
                            "is_root": suite.get("isOpen", False)
                        })
                    
                    if suites:
                        logger.info(f"✅ Returning {len(suites)} suites from REST API")
                        print(f"[FETCH_SUITES DEBUG] REST API found suites, returning", flush=True)
                        return suites
                    else:
                        logger.info(f"📋 REST API returned 200 but no suites, will try fallback...")
                        print(f"[FETCH_SUITES DEBUG] REST API empty, will continue to WIQL fallback...", flush=True)
                except Exception as je:
                    logger.error(f"❌ Failed to parse JSON response: {str(je)}")
                    print(f"[FETCH_SUITES DEBUG] JSON parse error: {str(je)}", flush=True)
            else:
                response_text = response.text[:300] if response.text else "No response body"
                logger.warning(f"⚠️ REST API returned {response.status_code} for plan {plan_id}")
                print(f"[FETCH_SUITES DEBUG] REST API error {response.status_code}: {response_text}", flush=True)
        
        # If REST API didn't work or returned empty, try WIQL fallback to get all suites for the plan
        if not suites:
            logger.info(f"📋 Trying WIQL fallback to get test suites...")
            print(f"[FETCH_SUITES DEBUG] WIQL fallback triggered - no suites from REST API", flush=True)
            try:
                # Query for all Test Suite work items in this project
                wiql_query = f"SELECT [System.Id], [System.Title], [System.Description] FROM WorkItems WHERE [System.TeamProject] = '{project}' AND [System.WorkItemType] = 'Test Suite' ORDER BY [System.CreatedDate] DESC"
                
                url = f"{collection_url}/{project}/_apis/wit/wiql?api-version=6.0"
                logger.info(f"📤 Executing WIQL query for test suites")
                print(f"[FETCH_SUITES DEBUG] Trying WIQL query: {url}", flush=True)
                
                response = requests.post(
                    url,
                    json={"query": wiql_query},
                    auth=auth_obj,
                    headers=headers,
                    timeout=30,
                    verify=False
                )
                
                logger.info(f"📥 WIQL response status: {response.status_code}")
                print(f"[FETCH_SUITES DEBUG] WIQL status: {response.status_code}", flush=True)
                
                if response.status_code == 200:
                    data = response.json()
                    work_items = data.get("workItems", [])
                    logger.info(f"✅ WIQL query found {len(work_items)} test suite work items")
                    print(f"[FETCH_SUITES DEBUG] WIQL found {len(work_items)} work items", flush=True)
                    
                    # Fetch details for each work item (in batches to avoid URL length issues)
                    if work_items:
                        batch_size = 100
                        for batch_start in range(0, len(work_items), batch_size):
                            batch_end = min(batch_start + batch_size, len(work_items))
                            batch = work_items[batch_start:batch_end]
                            ids_str = ",".join([str(wi.get("id")) for wi in batch])
                            
                            detail_url = f"{collection_url}/{project}/_apis/wit/workitems?ids={ids_str}&fields=System.Id,System.Title,System.Description&api-version=6.0"
                            logger.info(f"📤 Fetching details for batch {batch_start}-{batch_end}...")
                            
                            detail_response = requests.get(
                                detail_url,
                                auth=auth_obj,
                                headers=headers,
                                timeout=30,
                                verify=False
                            )
                            
                            if detail_response.status_code == 200:
                                detail_data = detail_response.json()
                                batch_items = detail_data.get("value", [])
                                for wi in batch_items:
                                    suites.append({
                                        "id": str(wi.get("id", "")),
                                        "name": wi.get("fields", {}).get("System.Title", f"Suite {wi.get('id')}"),
                                        "type": "Test Suite",
                                        "is_root": False
                                    })
                                logger.info(f"📥 Batch {batch_start}-{batch_end}: Added {len(batch_items)} suites")
                                print(f"[FETCH_SUITES DEBUG] Batch {batch_start}-{batch_end}: {len(batch_items)} items", flush=True)
                            else:
                                logger.warning(f"⚠️ Failed to fetch batch {batch_start}-{batch_end} (status {detail_response.status_code})")
                        
                        logger.info(f"✅ Added {len(suites)} test suites from WIQL fallback")
                        print(f"[FETCH_SUITES DEBUG] Total from WIQL: {len(suites)} suites", flush=True)
                        if suites:
                            return suites
                else:
                    logger.warning(f"⚠️ WIQL query failed with status {response.status_code}")
                    response_text = response.text[:300] if response.text else "No response"
                    print(f"[FETCH_SUITES DEBUG] WIQL failed: {response.status_code} - {response_text}", flush=True)
            except Exception as e:
                logger.error(f"❌ WIQL fallback failed: {str(e)}", exc_info=True)
                print(f"[FETCH_SUITES DEBUG] WIQL exception: {str(e)}", flush=True)
            
    except requests.exceptions.ConnectionError as e:
        logger.error(f"❌ Connection error: {str(e)}")
        logger.error(f"  Make sure TFS server is accessible at: {collection_url}")
    except requests.exceptions.Timeout as e:
        logger.error(f"❌ Timeout error: {str(e)}")
    except Exception as e:
        logger.error(f"❌ Exception in fetch_test_suites: {str(e)}", exc_info=True)
    
    logger.info(f"📊 Returning {len(suites)} suites")
    print(f"[FETCH_SUITES DEBUG] Final result: {len(suites)} suites", flush=True)
    return suites


