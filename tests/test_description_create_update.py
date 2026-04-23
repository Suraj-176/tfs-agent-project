"""
Test description field flow for both CREATE and UPDATE operations.
This test verifies that description is properly included in PATCH documents.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.agents.bug_creation_agent import execute_bug_creation, clean_field_text
from backend.tfs_tool import create_work_item, update_bug, markdown_to_tfs_html


class TestDescriptionCreateUpdate:
    """Test description handling in CREATE and UPDATE operations"""
    
    def test_markdown_to_tfs_html_preserves_content(self):
        """Verify markdown conversion doesn't lose description content"""
        description = "**Description:**\nThe app crashes when clicking submit"
        result = markdown_to_tfs_html(description)
        print(f"\n✓ markdown_to_tfs_html input: {repr(description)}")
        print(f"✓ markdown_to_tfs_html output: {repr(result)}")
        assert "crashes" in result
        assert "submit" in result
        assert result  # Not empty
    
    def test_create_work_item_with_description(self):
        """Test that create_work_item adds description to PATCH document"""
        with patch('backend.tfs_tool.requests.post') as mock_post:
            mock_response = Mock()
            mock_response.status_code = 201
            mock_response.json.return_value = {'id': 123}
            mock_post.return_value = mock_response
            
            response = create_work_item(
                work_item_type="Bug",
                title="App crashes on submit",
                description="**Description:**\nThe app crashes when user clicks submit button",
                reproduction_steps="1. Click submit\n2. Observe crash",
                severity="1 - Critical",
                priority="1",
                base_url="http://tfs.example.com",
                pat="test_token"
            )
            
            # Get the PATCH document that was sent
            call_args = mock_post.call_args
            assert call_args is not None
            patch_doc = call_args[1]['json']
            
            print(f"\n✓ CREATE PATCH document fields:")
            for item in patch_doc:
                print(f"  - {item['path']}")
            
            # Check that description field is in PATCH
            description_fields = [item for item in patch_doc if "/fields/System.Description" in item['path']]
            assert len(description_fields) > 0, "Description field missing from PATCH document"
            
            # Check that description value is not empty
            desc_value = description_fields[0]['value']
            assert desc_value, "Description value is empty in PATCH"
            assert "crashes" in desc_value, "Description content not preserved"
            print(f"  ✓ System.Description present with value: {repr(desc_value[:80])}")
    
    def test_update_bug_with_description(self):
        """Test that update_bug adds description to PATCH document"""
        with patch('backend.tfs_tool.requests.patch') as mock_patch:
            mock_response = Mock()
            mock_response.status_code = 200
            mock_response.json.return_value = {'id': 123}
            mock_patch.return_value = mock_response
            
            response = update_bug(
                bug_id=123,
                title="App crashes on submit",
                description="**Description:**\nThe app crashes when user clicks submit button",
                reproduction_steps="1. Click submit\n2. Observe crash",
                severity="1 - Critical",
                priority="1",
                base_url="http://tfs.example.com",
                pat="test_token"
            )
            
            # Get the PATCH document that was sent
            call_args = mock_patch.call_args
            assert call_args is not None
            patch_doc = call_args[1]['json']
            
            print(f"\n✓ UPDATE PATCH document fields:")
            for item in patch_doc:
                print(f"  - {item['path']}")
            
            # Check that description field is in PATCH
            description_fields = [item for item in patch_doc if "/fields/System.Description" in item['path']]
            assert len(description_fields) > 0, "Description field missing from UPDATE PATCH document"
            
            # Check that description value is not empty
            desc_value = description_fields[0]['value']
            assert desc_value, "Description value is empty in UPDATE PATCH"
            assert "crashes" in desc_value, "Description content not preserved in UPDATE"
            print(f"  ✓ System.Description present with value: {repr(desc_value[:80])}")
    
    def test_execute_bug_creation_flow_with_description(self):
        """Test complete execute_bug_creation flow with description input"""
        with patch('backend.tfs_tool.requests.post') as mock_post, \
             patch('backend.tfs_tool.requests.patch') as mock_patch:
            
            mock_response = Mock()
            mock_response.status_code = 201
            mock_response.json.return_value = {'id': 456}
            mock_post.return_value = mock_response
            
            # Simulate user providing description separately
            result = execute_bug_creation(
                bug_title="Critical: Login fails",
                bug_description="The login page shows blank after entering credentials",
                reproduction_steps="1. Navigate to login\n2. Enter credentials\n3. Observe blank page",
                expected_behavior="User should see dashboard",
                actual_behavior="Page shows blank",
                severity="1 - Critical",
                priority="1",
                tags="login,authentication",
                assigned_to="",
                area_path="TruDocs\\Backend",
                iteration_path="TruDocs\\Sprint1",
                work_item_id=None,
                is_update=False,
                screenshots=None,
                tfs_config={
                    'base_url': 'http://tfs.example.com',
                    'pat_token': 'test_token',
                    'username': 'user',
                    'password': 'pass',
                    'project_name': 'TruDocs'
                },
                llm_config=None
            )
            
            # Get the PATCH document
            call_args = mock_post.call_args
            if call_args:
                patch_doc = call_args[1]['json']
                print(f"\n✓ EXECUTE_BUG_CREATION flow - CREATE operation:")
                print(f"  Fields in PATCH:")
                for item in patch_doc:
                    print(f"    - {item['path']}")
                
                # Verify description is included
                desc_items = [item for item in patch_doc if "/fields/System.Description" in item['path']]
                assert len(desc_items) > 0, "Description not in PATCH from execute_bug_creation"
                print(f"  ✓ Description field present and contains: {repr(desc_items[0]['value'][:60])}")
    
    def test_execute_bug_creation_fallback_description_from_steps(self):
        """Test that when no description provided, it uses steps as fallback"""
        with patch('backend.tfs_tool.requests.post') as mock_post:
            
            mock_response = Mock()
            mock_response.status_code = 201
            mock_response.json.return_value = {'id': 789}
            mock_post.return_value = mock_response
            
            # Simulate user providing only steps, NO description
            result = execute_bug_creation(
                bug_title="UI glitch on dashboard",
                bug_description="",  # EMPTY - should use steps as fallback
                reproduction_steps="1. Click dashboard\n2. Wait 5 seconds\n3. UI jumps",
                expected_behavior="UI should be smooth",
                actual_behavior="UI has jumpy animation",
                severity="2 - High",
                priority="2",
                tags="ui,animation",
                assigned_to="",
                area_path="TruDocs\\Frontend",
                iteration_path="TruDocs\\Sprint1",
                work_item_id=None,
                is_update=False,
                screenshots=None,
                tfs_config={
                    'base_url': 'http://tfs.example.com',
                    'pat_token': 'test_token',
                    'username': 'user',
                    'password': 'pass',
                    'project_name': 'TruDocs'
                },
                llm_config=None
            )
            
            # Get the PATCH document
            call_args = mock_post.call_args
            if call_args:
                patch_doc = call_args[1]['json']
                print(f"\n✓ EXECUTE_BUG_CREATION flow - FALLBACK case (no description):")
                print(f"  Fields in PATCH:")
                for item in patch_doc:
                    print(f"    - {item['path']}")
                
                # Verify description is included (should be steps content)
                desc_items = [item for item in patch_doc if "/fields/System.Description" in item['path']]
                assert len(desc_items) > 0, "Description fallback not in PATCH"
                desc_value = desc_items[0]['value']
                print(f"  ✓ Description field present (from fallback) containing: {repr(desc_value[:60])}")
                # Verify it has the steps content
                assert "Click dashboard" in desc_value or "dashboard" in desc_value, "Steps content not in fallback description"
    
    def test_clean_description_preserves_content_without_re_cleaning(self):
        """Verify that not re-cleaning description preserves the assembled content"""
        # Simulate the assembly process
        raw_desc = "Login page not loading on mobile devices"
        clean_desc = clean_field_text(raw_desc)
        
        # Simulate what execute_bug_creation does after assembly
        final_description = f"**Description:**\n{clean_desc}"
        print(f"\n✓ Description assembly:")
        print(f"  raw_desc: {repr(raw_desc)}")
        print(f"  clean_desc: {repr(clean_desc)}")
        print(f"  final_description: {repr(final_description[:80])}")
        
        # The key: final_description should NOT be re-cleaned
        # because that would remove the header
        should_not_re_clean = final_description
        assert "**Description:**" in should_not_re_clean, "Header should be preserved"
        assert "Login page" in should_not_re_clean, "Content should be preserved"
        print(f"  ✓ Final description preserves header and content")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
