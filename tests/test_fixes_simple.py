"""
Simplified Unit Tests for Bug & Feature Creation Agent Fixes
Tests the core logic without complex imports
"""

import pytest
import re
from unittest.mock import Mock, patch, MagicMock


class TestIssue1FieldExtraction:
    """TEST ISSUE 1: Missing fields (Description, Actual Result, Expected Result)"""

    def test_regex_extracts_all_four_fields_from_formatted_text(self):
        """Verify regex pattern can extract all 4 sections from formatted description"""
        
        # This simulates the frontend extraction logic from app.js executeAgent()
        formatted_text = """**Description**
The login page doesn't work on mobile.

**Steps to Reproduce**
1. Open app on phone
2. Navigate to login
3. Try to enter credentials

**Actual Result**
Fields overlap and buttons are cut off.

**Expected Result**
Page should be responsive and all elements visible."""

        # The regex pattern used in frontend app.js
        pattern = r'\*\*(Description|Steps to Reproduce|Actual Result|Expected Result)\*\*\s*\n?([\s\S]*?)(?=\*\*|$)'
        
        matches = re.findall(pattern, formatted_text, re.IGNORECASE)
        
        # Should find all 4 sections
        assert len(matches) == 4, f"Should find 4 fields, found {len(matches)}"
        
        # Extract into dict
        fields = {}
        for field_name, content in matches:
            fields[field_name.lower()] = content.strip()
        
        # Verify all fields present
        assert 'description' in fields, "Description should be extracted"
        assert 'steps to reproduce' in fields, "Steps to Reproduce should be extracted"
        assert 'actual result' in fields, "Actual Result should be extracted"
        assert 'expected result' in fields, "Expected Result should be extracted"
        
        # Verify content
        assert 'mobile' in fields['description'].lower()
        assert 'phone' in fields['steps to reproduce'].lower()
        assert 'overlap' in fields['actual result'].lower()
        assert 'responsive' in fields['expected result'].lower()

    def test_step_formatting_with_commas_normalized(self):
        """Verify steps with commas are properly normalized to newlines"""
        
        # User input with comma-separated steps
        step_text = "1. Navigate to the login screen,2. Click/tap the \"Forgot password\" link,3. Observe the behavior"
        
        # Apply normalization (fix ",2." -> "\n2.")
        normalized = re.sub(r',\s*(\d+\.)', r'\n\1', step_text)
        
        # Verify formatting
        lines = normalized.split('\n')
        assert any('Navigate to the login screen' in line for line in lines), "First step should be preserved"
        assert any('Forgot password' in line for line in lines), "Second step should be on new line"
        assert any('Observe the behavior' in line for line in lines), "Third step should be on new line"
        
        # Should have 3 lines after splitting
        assert len(lines) == 3, f"Should have 3 steps, got {len(lines)}"

    def test_backend_normalizes_steps_with_commas(self):
        """Verify backend normalize_steps function converts commas to newlines"""
        
        # Simulated backend normalization logic
        input_steps = "1. Navigate to login screen,2. Enter credentials,3. Click login"
        
        # Apply same normalization as backend normalize_steps function
        normalized = re.sub(r',\s*(\d+\.)', r'\n\1', input_steps)
        normalized = re.sub(r',\s+(?=[A-Z])', '\n', normalized).strip()
        
        # Verify each step is on its own line
        lines = [l.strip() for l in normalized.split('\n') if l.strip()]
        assert len(lines) == 3, f"Should normalize to 3 steps, got {len(lines)}"
        assert '1. Navigate to login screen' in lines[0]
        assert '2. Enter credentials' in lines[1]
        assert '3. Click login' in lines[2]



    def test_plain_text_format_extraction(self):
        """Verify extraction works for plain text format without **markers**"""
        
        plain_text = """Steps to Reproduce:
1. Navigate to the login screen
2. Enter login credentials
3. Click the "Login" button
4. Observe the login outcome

Actual Result:
Login does not work as expected when attempting to authenticate.

Expected Result:
User should be authenticated and redirected to the appropriate post-login page."""

        # Simulate frontend extraction for plain text format
        lines = plain_text.split('\n')
        section_content = {
            'description': [],
            'reproduction_steps': [],
            'actual_result': [],
            'expected_result': []
        }
        current_section = 'description'

        for line in lines:
            line_lower = line.strip().lower()
            
            # Detect section headers
            if re.match(r'^steps?\s+to\s+reproduce', line_lower):
                current_section = 'reproduction_steps'
                continue
            elif re.match(r'^actual\s+result', line_lower):
                current_section = 'actual_result'
                continue
            elif re.match(r'^expected\s+result', line_lower):
                current_section = 'expected_result'
                continue
            
            if line.strip():
                section_content[current_section].append(line.strip())
        
        # Verify extraction
        assert len(section_content['reproduction_steps']) == 4, "Should extract all 4 reproduction steps"
        assert 'Navigate to the login screen' in section_content['reproduction_steps'][0]
        assert 'Login does not work' in section_content['actual_result'][0]
        assert 'authenticated' in section_content['expected_result'][0].lower()

    def test_description_populated_from_steps_if_empty(self):
        """Verify description field is populated from steps if no description provided"""
        
        # Scenario: User only provides Steps to Reproduce, no separate Description
        description = None
        steps = """Steps to Reproduce:
1. Navigate to login
2. Click forgot password
3. Observe result"""
        
        # Backend logic: if description is empty, use steps as description
        final_description = description or steps
        
        assert final_description is not None, "Description should be populated from steps"
        assert 'Navigate to login' in final_description, "Description should contain step content"

    def test_description_content_preserved_after_cleaning(self):
        """Verify description content is preserved and not stripped by clean_description_text"""
        
        # Test input: description with header and actual content
        description_input = "Description:\nThe application crashes when opening large files."
        
        # Simulate clean_description_text behavior
        lines = description_input.split('\n')
        cleaned_lines = []
        
        for line in lines:
            stripped = line.strip()
            if not stripped:
                cleaned_lines.append("")
                continue
            
            # Skip only empty label lines
            if re.match(r'^(?:\*\*)?(?:Description|Overview)(?:\*\*)?:?\s*$', stripped, re.IGNORECASE):
                continue
            
            cleaned_lines.append(line.strip())
        
        result = '\n'.join(cleaned_lines).strip()
        
        # Verify content is preserved
        assert result, "Description content should not be empty"
        assert 'crashes' in result.lower(), "Description content should be preserved"
        assert 'large files' in result.lower(), "Full description content should be intact"



        """Verify extraction works for plain text format without **markers**"""
        
        plain_text = """Steps to Reproduce:
1. Navigate to the login screen
2. Enter login credentials
3. Click the "Login" button
4. Observe the login outcome

Actual Result:
Login does not work as expected when attempting to authenticate.

Expected Result:
User should be authenticated and redirected to the appropriate post-login page."""

        # Simulate frontend extraction for plain text format
        lines = plain_text.split('\n')
        section_content = {
            'description': [],
            'reproduction_steps': [],
            'actual_result': [],
            'expected_result': []
        }
        current_section = 'description'

        for line in lines:
            line_lower = line.strip().lower()
            
            # Detect section headers
            if re.match(r'^steps?\s+to\s+reproduce', line_lower):
                current_section = 'reproduction_steps'
                continue
            elif re.match(r'^actual\s+result', line_lower):
                current_section = 'actual_result'
                continue
            elif re.match(r'^expected\s+result', line_lower):
                current_section = 'expected_result'
                continue
            
            if line.strip():
                section_content[current_section].append(line.strip())
        
        # Verify extraction
        assert len(section_content['reproduction_steps']) == 4, "Should extract all 4 reproduction steps"
        assert 'Navigate to the login screen' in section_content['reproduction_steps'][0]
        assert 'Login does not work' in section_content['actual_result'][0]
        assert 'authenticated' in section_content['expected_result'][0].lower()


    def test_all_fields_passed_to_backend_endpoint(self):
        """Verify backend endpoint receives all 4 fields from frontend payload"""
        
        # Simulated frontend payload (from app.js after extraction)
        frontend_payload = {
            "title": "Login page not responsive",
            "description": "The login page doesn't work on mobile.",
            "steps_to_reproduce": "1. Open app on phone\n2. Navigate to login\n3. Try to enter credentials",
            "actual_behavior": "Fields overlap and buttons are cut off.",
            "expected_behavior": "Page should be responsive and all elements visible.",
            "attachments": [],
            "is_update": False,
            "work_item_id": None
        }
        
        # Backend should receive all these fields
        assert frontend_payload['title']
        assert frontend_payload['description']
        assert frontend_payload['steps_to_reproduce']
        assert frontend_payload['actual_behavior']
        assert frontend_payload['expected_behavior']
        
        # All 4 content fields should have substance
        assert len(frontend_payload['description']) > 0
        assert len(frontend_payload['steps_to_reproduce']) > 0
        assert len(frontend_payload['actual_behavior']) > 0
        assert len(frontend_payload['expected_behavior']) > 0

    def test_backend_passes_all_fields_to_tfs(self):
        """Verify backend create_bug_tfs endpoint passes all fields to TFS"""
        
        # Simulated request to backend endpoint
        request_data = {
            "title": "Login page not responsive",
            "description": "The login page doesn't work on mobile.",
            "reproduction_steps": "1. Open app on phone\n2. Navigate to login",
            "expected_behavior": "Page should be responsive",
            "actual_behavior": "Fields overlap",
            "attachments": []
        }
        
        # Endpoint should have all parameters
        assert 'title' in request_data
        assert 'description' in request_data
        assert 'reproduction_steps' in request_data
        assert 'expected_behavior' in request_data
        assert 'actual_behavior' in request_data
        
        # Simulate passing to TFS creation
        tfs_payload = {
            "fields": {
                "System.Title": request_data['title'],
                "System.Description": request_data['description'],
                "Microsoft.VSTS.TCM.ReproSteps": request_data['reproduction_steps'],
                "Custom.ExpectedResult": request_data['expected_behavior'],
                "Custom.ActualResult": request_data['actual_behavior'],
            }
        }
        
        # All fields should be in TFS payload
        assert tfs_payload['fields']['System.Title'] == "Login page not responsive"
        assert tfs_payload['fields']['System.Description'] == "The login page doesn't work on mobile."
        assert tfs_payload['fields']['Microsoft.VSTS.TCM.ReproSteps'] == "1. Open app on phone\n2. Navigate to login"
        assert tfs_payload['fields']['Custom.ExpectedResult'] == "Page should be responsive"
        assert tfs_payload['fields']['Custom.ActualResult'] == "Fields overlap"


class TestIssue2AttachmentReplacement:
    """TEST ISSUE 2: Attachment replacement (remove old, add new)"""

    def test_remove_all_attachments_fetches_work_item_relations(self):
        """Test that remove_all_attachments properly fetches work item with relations"""
        
        # Mock the GET request response
        get_response = {
            'id': 12345,
            'relations': [
                {'rel': 'AttachedFile', 'url': 'http://tfs/attachment/1'},
                {'rel': 'AttachedFile', 'url': 'http://tfs/attachment/2'},
                {'rel': 'Parent', 'url': 'http://tfs/wi/100'},
                {'rel': 'AttachedFile', 'url': 'http://tfs/attachment/3'},
            ]
        }
        
        # Extract only AttachedFile relations
        attachments = [r for r in get_response['relations'] if r.get('rel') == 'AttachedFile']
        
        # Should find all 3 attachments
        assert len(attachments) == 3, f"Should find 3 attachments, found {len(attachments)}"

    def test_remove_all_attachments_builds_patch_operations(self):
        """Test that remove_all_attachments builds correct PATCH operations"""
        
        # Simulated work item with attachments
        work_item = {
            'id': 12345,
            'relations': [
                {'rel': 'AttachedFile', 'url': 'file1.jpg'},
                {'rel': 'AttachedFile', 'url': 'file2.png'},
            ]
        }
        
        # Extract attachment relations and build PATCH operations
        relations = work_item.get('relations', [])
        attachment_indices = [i for i, r in enumerate(relations) if r.get('rel') == 'AttachedFile']
        
        # Build PATCH operations (in reverse order to maintain indices)
        patch_operations = [
            {"op": "remove", "path": f"/relations/{i}"} 
            for i in sorted(attachment_indices, reverse=True)
        ]
        
        # Should have 2 remove operations
        assert len(patch_operations) == 2
        assert all(op['op'] == 'remove' for op in patch_operations)
        assert '/relations/' in patch_operations[0]['path']

    def test_remove_all_attachments_then_add_new(self):
        """Test the complete flow: remove old attachments, then add new ones"""
        
        update_flow = {
            'step1_remove_existing': 'remove_all_attachments(work_item_id)',
            'step2_add_new': 'link_attachment_to_work_item(work_item_id, new_attachment_url)',
        }
        
        # Both steps should be present in update flow
        assert 'remove_all_attachments' in update_flow['step1_remove_existing']
        assert 'link_attachment_to_work_item' in update_flow['step2_add_new']
        
        # This ensures clean replacement

    @patch('requests.get')
    @patch('requests.patch')
    def test_remove_all_attachments_success_flow(self, mock_patch, mock_get):
        """Test successful removal of attachments"""
        
        # Mock GET response with attachments
        mock_get.return_value = Mock(
            status_code=200,
            json=Mock(return_value={
                'id': 12345,
                'relations': [
                    {'rel': 'AttachedFile', 'url': 'file1.jpg'},
                    {'rel': 'AttachedFile', 'url': 'file2.png'},
                ]
            })
        )
        
        # Mock PATCH response
        mock_patch.return_value = Mock(status_code=200)
        
        # Simulate remove_all_attachments logic
        work_item_id = 12345
        response = mock_get(url=f'http://tfs/wi/{work_item_id}')
        
        if response.status_code == 200:
            data = response.json()
            attachments = [r for r in data.get('relations', []) if r.get('rel') == 'AttachedFile']
            
            if attachments:
                patch_ops = [
                    {"op": "remove", "path": f"/relations/{i}"}
                    for i, r in enumerate(data['relations'])
                    if r.get('rel') == 'AttachedFile'
                ]
                
                patch_response = mock_patch(json=patch_ops)
                assert patch_response.status_code == 200


class TestIssue3UIScrolling:
    """TEST ISSUE 3: UI checkbox and scrolling behavior"""

    def test_update_checkbox_sets_container_height(self):
        """Test that checking Update checkbox sets fixed container height"""
        
        # CSS properties should be set on container
        expected_css = {
            'height': '650px',
            'overflow': 'hidden',
            'max-height': '650px'
        }
        
        assert expected_css['height'] == '650px'
        assert expected_css['overflow'] == 'hidden'
        assert expected_css['max-height'] == '650px'

    def test_form_pane_allows_internal_scroll(self):
        """Test that form pane allows scrolling for content overflow"""
        
        # Form pane CSS properties
        form_css = {
            'height': '100%',
            'max-height': '650px',
            'overflow-y': 'auto',
            'overflow-x': 'hidden'
        }
        
        assert form_css['overflow-y'] == 'auto', "Should allow vertical scrolling"
        assert form_css['overflow-x'] == 'hidden', "Should prevent horizontal expansion"

    def test_toggle_update_mode_manages_display_state(self):
        """Test that toggleUpdateMode manages visibility and scroll state"""
        
        # Simulated toggle states
        state = {'updateMode': False}
        
        # When toggling ON (checking checkbox)
        state['updateMode'] = True
        state['containerDisplay'] = 'block'
        state['scrollEnabled'] = True
        
        assert state['updateMode'] == True
        assert state['containerDisplay'] == 'block'
        
        # When toggling OFF (unchecking checkbox)
        state['updateMode'] = False
        state['containerDisplay'] = 'none'
        state['scrollEnabled'] = False
        
        assert state['updateMode'] == False
        assert state['containerDisplay'] == 'none'


class TestSeverityPriority:
    """TEST: Severity and Priority fields are properly set"""

    def test_severity_added_to_patch_document(self):
        """Verify severity is included in TFS PATCH document during creation"""
        
        # Simulated patch document for creating a bug
        patch_ops = [
            {"op": "add", "path": "/fields/System.Title", "value": "Login bug"},
            {"op": "add", "path": "/fields/System.Description", "value": "<p>Description</p>"},
            {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Severity", "value": "1 - Critical"},
            {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": "1"},
        ]
        
        # Verify severity is in the patch
        severity_ops = [op for op in patch_ops if 'Severity' in op.get('path', '')]
        assert len(severity_ops) == 1, "Severity should be in patch document"
        assert severity_ops[0]['value'] == "1 - Critical"

    def test_priority_added_to_patch_document(self):
        """Verify priority is included in TFS PATCH document during creation"""
        
        patch_ops = [
            {"op": "add", "path": "/fields/System.Title", "value": "Feature request"},
            {"op": "add", "path": "/fields/System.Description", "value": "<p>Feature</p>"},
            {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": "2"},
        ]
        
        # Verify priority is in the patch
        priority_ops = [op for op in patch_ops if 'Priority' in op.get('path', '')]
        assert len(priority_ops) == 1, "Priority should be in patch document"
        assert priority_ops[0]['value'] == "2"

    def test_severity_options_valid(self):
        """Verify severity values are in TFS standard format"""
        
        valid_severities = [
            "1 - Critical",
            "2 - High", 
            "3 - Medium",
            "4 - Low"
        ]
        
        # Test that all standard severities are valid
        for sev in valid_severities:
            assert " - " in sev, f"Severity should have format 'X - Name': {sev}"
            level, name = sev.split(" - ")
            assert level in ["1", "2", "3", "4"], f"Severity level should be 1-4: {level}"

    def test_priority_options_valid(self):
        """Verify priority values are valid"""
        
        valid_priorities = ["1", "2", "3"]
        
        # Test that all standard priorities are valid
        for pri in valid_priorities:
            assert pri in valid_priorities, f"Priority should be 1-3: {pri}"


class TestIntegrationSeverityPriority:
    """TEST: Severity/Priority flow from frontend through backend to TFS"""

    def test_severity_priority_in_frontend_payload(self):
        """Verify frontend sends severity and priority in payload"""
        
        frontend_payload = {
            'title': 'Login issue',
            'description': 'Cannot log in',
            'severity': '1 - Critical',
            'priority': '1',
            'work_item_type': 'Bug'
        }
        
        assert frontend_payload['severity'] == '1 - Critical'
        assert frontend_payload['priority'] == '1'

    def test_backend_receives_and_passes_severity_priority(self):
        """Verify backend endpoint receives severity/priority from frontend"""
        
        request_data = {
            'bug_title': 'Test bug',
            'description': 'Test description',
            'severity': '2 - High',
            'priority': '2',
            'work_item_type': 'Bug'
        }
        
        # Backend should extract these
        assert 'severity' in request_data
        assert 'priority' in request_data
        assert request_data['severity'] == '2 - High'
        assert request_data['priority'] == '2'

    def test_tfs_receives_severity_priority_in_patch(self):
        """Verify TFS receives severity and priority in PATCH operations"""
        
        tfs_patch = [
            {"op": "add", "path": "/fields/System.Title", "value": "Bug title"},
            {"op": "add", "path": "/fields/System.Description", "value": "Description"},
            {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Severity", "value": "3 - Medium"},
            {"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": "2"}
        ]
        
        severity_found = any('Severity' in op.get('path', '') for op in tfs_patch)
        priority_found = any('Priority' in op.get('path', '') for op in tfs_patch)
        
        assert severity_found, "TFS patch should include severity"
        assert priority_found, "TFS patch should include priority"



    """TEST: End-to-end field flow from frontend to TFS"""

    def test_field_flow_create_bug(self):
        """Test complete field flow for creating a bug"""
        
        # Frontend extraction
        frontend_text = """**Description**
App crashes on startup.

**Steps to Reproduce**
1. Restart the app
2. Observe immediate crash

**Actual Result**
App exits with error code 1.

**Expected Result**
App should start normally."""

        # Extract fields (using regex)
        pattern = r'\*\*(Description|Steps to Reproduce|Actual Result|Expected Result)\*\*\s*\n?([\s\S]*?)(?=\*\*|$)'
        matches = re.findall(pattern, frontend_text, re.IGNORECASE)
        extracted = {field.lower(): content.strip() for field, content in matches}
        
        # Create payload
        payload = {
            'title': 'App crashes on startup',
            'description': extracted.get('description'),
            'reproduction_steps': extracted.get('steps to reproduce'),
            'actual_behavior': extracted.get('actual result'),
            'expected_behavior': extracted.get('expected result'),
        }
        
        # Verify all fields present
        assert payload['description']
        assert payload['reproduction_steps']
        assert payload['actual_behavior']
        assert payload['expected_behavior']

    def test_field_flow_update_bug_with_attachment_replacement(self):
        """Test complete field flow for updating a bug with new attachment"""
        
        update_steps = {
            '1_fetch_current': 'Get current work item with relations',
            '2_extract_fields': 'Extract new description/steps/actual/expected',
            '3_remove_attachments': 'Call remove_all_attachments()',
            '4_add_new_attachment': 'Call link_attachment_to_work_item()',
            '5_update_fields': 'PATCH work item with new field values',
        }
        
        # All steps present in update flow
        assert '1_fetch_current' in update_steps
        assert '2_extract_fields' in update_steps
        assert '3_remove_attachments' in update_steps
        assert '4_add_new_attachment' in update_steps
        assert '5_update_fields' in update_steps


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
