from crewai import Agent, Task, Crew
from ..llm_config import get_configured_llm
import logging

logger = logging.getLogger(__name__)


def create_testcase_review_agent(llm_config: dict = None):
    """
    Test Case Review Agent
    Analyzes and reviews generated test cases for coverage, quality, and completeness
    """
    try:
        llm = get_configured_llm(llm_config) if llm_config else None
        if not llm:
            logger.warning("No LLM configured for review agent, will use defaults")
    except Exception as e:
        logger.error(f"Error configuring LLM: {e}")
        llm = None
    
    agent = Agent(
        role="Senior QA Test Review Specialist",
        goal="Review test cases for coverage, quality, and alignment with user story requirements",
        backstory="""Expert QA professional with expertise in:
        - Test case quality assurance
        - Requirements coverage analysis
        - Test design best practices
        
        Provide actionable reviews focused on completeness and quality.""",
        llm=llm,
        verbose=False,
        allow_delegation=False
    )
    
    return agent


def execute_testcase_review(
    test_cases: str,
    story_details: str = "",
    llm_config: dict = None
):
    """
    Execute comprehensive test case review
    
    Args:
        test_cases: Generated test cases in markdown format
        story_details: Original user story/requirements
        llm_config: LLM configuration
        
    Returns:
        Review analysis with findings and recommendations
    """
    try:
        logger.info("Starting test case review...")
        agent = create_testcase_review_agent(llm_config)
        
        # Simplified prompt to avoid timeout issues
        task = Task(
            description=f"""Analyze these test cases:

REQUIREMENTS:
{story_details if story_details else "No requirements provided"}

TEST CASES:
{test_cases[:3000]}  

Provide a brief analysis:
1. Coverage: Which requirements are covered? What's missing?
2. Quality: Are steps clear and measurable?
3. Gaps: What edge cases or scenarios are missing?
4. Recommendations: 3-5 specific improvements needed

Be concise and actionable.""",
            agent=agent,
            expected_output="Test case review analysis"
        )
        
        crew = Crew(
            agents=[agent],
            tasks=[task],
            verbose=False
        )
        
        result = crew.kickoff()
        logger.info("Test case review completed successfully")
        return {
            "status": "success",
            "review": str(result),
            "agent": "Test Case Review Agent"
        }
    
    except Exception as e:
        logger.error(f"Test case review error: {str(e)}", exc_info=True)
        return {
            "status": "error",
            "error": str(e),
            "agent": "Test Case Review Agent"
        }


def execute_testcase_analysis(
    test_cases: str,
    story_details: str = "",
    question: str = "",
    chat_history: list = None,
    llm_config: dict = None
):
    """
    Execute AI analysis for user questions about test cases
    
    Args:
        test_cases: Generated test cases in markdown format
        story_details: Original user story/requirements
        question: User's specific question
        chat_history: Previous conversation history
        llm_config: LLM configuration
        
    Returns:
        Analysis response to user question
    """
    try:
        logger.info(f"Analyzing test cases with question: {question[:100]}")
        
        try:
            llm = get_configured_llm(llm_config) if llm_config else None
            if not llm:
                logger.warning("No LLM configured for analysis agent")
        except Exception as e:
            logger.error(f"Error configuring LLM: {e}")
            llm = None
        
        agent = Agent(
            role="QA Test Analysis Specialist",
            goal="Answer questions about test cases and provide targeted analysis",
            backstory="""QA analyst with expertise in test evaluation and requirements analysis.
            Provide focused, accurate answers about test coverage and quality.""",
            llm=llm,
            verbose=False,
            allow_delegation=False
        )
        
        # Simplified task with better structure
        task = Task(
            description=f"""Answer this question about test cases:

REQUIREMENTS:
{story_details[:1000] if story_details else "No requirements"}

TEST CASES:
{test_cases[:2000]}

QUESTION:
{question}

Provide a direct, specific answer. If question asks about missing cases, suggest 2-3 specific test cases.""",
            agent=agent,
            expected_output="Answer to the user's question"
        )
        
        crew = Crew(
            agents=[agent],
            tasks=[task],
            verbose=False
        )
        
        result = crew.kickoff()
        logger.info("Test case analysis completed successfully")
        return {
            "status": "success",
            "response": str(result),
            "agent": "Test Case Analysis Agent"
        }
    
    except Exception as e:
        logger.error(f"Test case analysis error: {str(e)}", exc_info=True)
        return {
            "status": "error",
            "error": str(e),
            "agent": "Test Case Analysis Agent"
        }


def execute_generate_missing_testcases(
    story_details: str = "",
    review_text: str = "",
    llm_config: dict = None
):
    """
    Generate missing test cases based on review findings
    
    Args:
        story_details: Original user story/requirements
        review_text: Review output that mentions missing cases
        llm_config: LLM configuration
        
    Returns:
        Generated test cases in markdown format for missing scenarios
    """
    try:
        logger.info("Generating missing test cases based on review...")
        
        try:
            llm = get_configured_llm(llm_config) if llm_config else None
            if not llm:
                logger.warning("No LLM configured for missing cases generation")
        except Exception as e:
            logger.error(f"Error configuring LLM: {e}")
            llm = None
        
        agent = Agent(
            role="Senior QA Test Designer",
            goal="Generate missing test cases based on review findings",
            backstory="""Expert QA engineer who creates high-quality test cases
            matching specification format perfectly.""",
            llm=llm,
            verbose=False,
            allow_delegation=False
        )
        
        task = Task(
            description=f"""Generate ONLY the missing test cases mentioned in the review.

REQUIREMENTS:
{story_details[:800] if story_details else "No requirements"}

REVIEW FINDINGS (mentions missing cases):
{review_text[:1500]}

Generate test cases ONLY for the missing scenarios identified in review.

Output ONLY as markdown table with 3 columns:
| Title | Step Action | Step Expected |

Format (STRICT):
1. Row 1: Column headers
2. Row 2+: Test case title only (empty step columns)
3. Next rows: Steps for that test case
4. Repeat for each test case

NO prefixes, NO step numbers in actions. Keep concise.""",
            agent=agent,
            expected_output="Markdown table with missing test cases"
        )
        
        crew = Crew(
            agents=[agent],
            tasks=[task],
            verbose=False
        )
        
        result = crew.kickoff()
        logger.info("Missing test cases generated successfully")
        return {
            "status": "success",
            "missing_cases": str(result),
            "agent": "Missing Test Case Generator"
        }
    
    except Exception as e:
        logger.error(f"Missing test cases generation error: {str(e)}", exc_info=True)
        return {
            "status": "error",
            "error": str(e),
            "agent": "Missing Test Case Generator"
        }
