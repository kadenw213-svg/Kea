// Canvas API answers for one made-up class, shaped exactly as Canvas's REST API documents them (Assignments,
// Submissions, Discussion Topics, Quizzes, Modules, Enrollments, Calendar Events, Conversations), including its
// "while(1);" prefix and Link-header paging. Used to check Kea's Canvas reader end to end without a Canvas school.
const HOST = 'https://school.instructure.com';
const C = 555;
const ME = 42;
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
const url = (p) => `${HOST}${p}`;
const sub = (id, s = {}) => ({ id: 9000 + id, assignment_id: id, user_id: ME, workflow_state: 'unsubmitted', submitted_at: null, score: null, grade: null, graded_at: null, excused: false, missing: false, late: false, attempt: null, ...s });

const assignments = [
  // A lab report to upload, due in a week, not handed in yet, opening in two days.
  { id: 101, name: 'Lab 3 Report', description: '<p>Upload your lab report as a PDF. See the <a href="/courses/555/files/77">template</a>.</p>', due_at: day(7), unlock_at: day(2), lock_at: day(10), points_possible: 20, grading_type: 'points', submission_types: ['online_upload'], html_url: url(`/courses/${C}/assignments/101`), published: true, rubric: [{ id: '_1', description: 'Data table', points: 10, ratings: [{ description: 'Complete', long_description: 'Every trial recorded', points: 10 }, { description: 'Missing', points: 0 }] }], submission: sub(101) },
  // Graded essay (handed in three weeks ago).
  { id: 102, name: 'Essay 1', description: '<p>Argument essay.</p>', due_at: day(-20), unlock_at: null, lock_at: null, points_possible: 100, grading_type: 'points', submission_types: ['online_upload', 'online_text_entry'], html_url: url(`/courses/${C}/assignments/102`), published: true, submission: sub(102, { workflow_state: 'graded', submitted_at: day(-21), score: 88, grade: '88', graded_at: day(-15) }) },
  // Missed homework (Canvas flags it missing).
  { id: 103, name: 'Homework 2', description: '', due_at: day(-10), unlock_at: null, lock_at: null, points_possible: 10, grading_type: 'points', submission_types: ['online_upload'], html_url: url(`/courses/${C}/assignments/103`), published: true, submission: sub(103, { missing: true }) },
  // Classic quiz, taken and scored.
  { id: 104, name: 'Quiz 1', description: '<p>Chapters 1-2</p>', due_at: day(-5), unlock_at: day(-12), lock_at: day(-4), points_possible: 15, grading_type: 'points', submission_types: ['online_quiz'], quiz_id: 9001, is_quiz_assignment: true, html_url: url(`/courses/${C}/assignments/104`), published: true, submission: sub(104, { workflow_state: 'graded', submitted_at: day(-6), score: 13, grade: '13', attempt: 1, graded_at: day(-6) }) },
  // New Quizzes (an outside tool to Canvas), coming up.
  { id: 105, name: 'Chapter 5 Quiz', description: '', due_at: day(4), unlock_at: day(1), lock_at: null, points_possible: 25, grading_type: 'points', submission_types: ['external_tool'], is_quiz_lti_assignment: true, external_tool_tag_attributes: { url: 'https://school.quiz-lti-iad-prod.instructure.com/lti/launch' }, html_url: url(`/courses/${C}/assignments/105`), published: true, submission: sub(105) },
  // Graded discussion, posted.
  { id: 106, name: 'Week 3 Discussion', description: '<p>Post and reply twice.</p>', due_at: day(-3), unlock_at: null, lock_at: null, points_possible: 10, grading_type: 'points', submission_types: ['discussion_topic'], discussion_topic: { id: 7001 }, html_url: url(`/courses/${C}/discussion_topics/7001`), published: true, submission: sub(106, { workflow_state: 'submitted', submitted_at: day(-4) }) },
  // ALEKS homework launched from Canvas, coming up.
  { id: 107, name: 'ALEKS Homework 4.5', description: '', due_at: day(3), unlock_at: null, lock_at: null, points_possible: 5, grading_type: 'points', submission_types: ['external_tool'], external_tool_tag_attributes: { url: 'https://lti.aleks.com/lti/launch' }, html_url: url(`/courses/${C}/assignments/107`), published: true, submission: sub(107) },
  // An in-class exam, graded.
  { id: 108, name: 'Exam 1', description: '', due_at: day(-8), unlock_at: null, lock_at: null, points_possible: 100, grading_type: 'points', submission_types: ['on_paper'], html_url: url(`/courses/${C}/assignments/108`), published: true, submission: sub(108, { workflow_state: 'graded', score: 76, grade: '76', graded_at: day(-6) }) },
  // An upcoming essay (the kind of work Kea must never mark graded).
  { id: 109, name: 'Essay 2', description: '<p>Research essay.</p>', due_at: day(12), unlock_at: null, lock_at: null, points_possible: 100, grading_type: 'points', submission_types: ['online_upload'], html_url: url(`/courses/${C}/assignments/109`), published: true, submission: sub(109) },
  // Excused work.
  { id: 110, name: 'Homework 1', description: '', due_at: day(-25), unlock_at: null, lock_at: null, points_possible: 10, grading_type: 'points', submission_types: ['online_upload'], html_url: url(`/courses/${C}/assignments/110`), published: true, submission: sub(110, { excused: true, workflow_state: 'graded' }) }
];

const routes = {
  // Paged: the first five assignments, then a Link to the rest.
  [`/api/v1/courses/${C}/assignments?per_page=100&include[]=submission&order_by=due_at`]: { body: assignments.slice(0, 5), next: `${HOST}/api/v1/courses/${C}/assignments?page=2&per_page=100&include[]=submission&order_by=due_at` },
  [`/api/v1/courses/${C}/assignments?page=2&per_page=100&include[]=submission&order_by=due_at`]: { body: assignments.slice(5) },
  [`/api/v1/courses/${C}/students/submissions?per_page=100&include[]=submission_comments`]: { body: [{ assignment_id: 102, submission_comments: [{ author_id: 7, comment: 'Strong thesis; cite more sources.' }, { author_id: ME, comment: 'Thank you!' }] }] },
  '/api/v1/users/self': { body: { id: ME, name: 'Student' } },
  [`/api/v1/courses/${C}/discussion_topics?per_page=100`]: {
    body: [
      { id: 7001, title: 'Week 3 Discussion', message: '<p>Post and reply twice.</p>', assignment_id: 106, html_url: url(`/courses/${C}/discussion_topics/7001`), published: true, require_initial_post: true, delayed_post_at: null, lock_at: null },
      { id: 7002, title: 'Introduce Yourself', message: '<p>Say hi.</p>', assignment_id: null, todo_date: null, html_url: url(`/courses/${C}/discussion_topics/7002`), published: true, delayed_post_at: null, lock_at: null }
    ]
  },
  [`/api/v1/courses/${C}/discussion_topics/7001/view`]: { body: { participants: [], view: [{ id: 1, user_id: ME, parent_id: null, replies: [{ id: 3, user_id: 7, parent_id: 1 }] }, { id: 2, user_id: 7, parent_id: null, replies: [{ id: 4, user_id: ME, parent_id: 2 }] }] } },
  [`/api/v1/courses/${C}/quizzes?per_page=100`]: { body: [{ id: 9001, title: 'Quiz 1', assignment_id: 104, published: true }, { id: 9002, title: 'Practice Quiz Ch 2', assignment_id: null, quiz_type: 'practice_quiz', due_at: null, html_url: url(`/courses/${C}/quizzes/9002`), published: true }] },
  [`/api/v1/courses/${C}/discussion_topics?only_announcements=true&per_page=50`]: { body: [{ id: 8001, title: 'Exam 2 moved', message: '<p>Exam 2 is now <b>Friday</b>. See <a href="https://school.instructure.com/courses/555/pages/exam-2">the review</a>.</p>', posted_at: day(-1), created_at: day(-1), delayed_post_at: null, html_url: url(`/courses/${C}/discussion_topics/8001`) }, { id: 8002, title: 'Future announcement', message: 'x', delayed_post_at: day(3), posted_at: null, html_url: url(`/courses/${C}/discussion_topics/8002`) }] },
  [`/api/v1/courses/${C}/enrollments?user_id=self&type[]=StudentEnrollment`]: { body: [{ type: 'StudentEnrollment', grades: { current_score: 87.5, current_grade: 'B+', final_score: 80.1 } }] },
  [`/api/v1/courses/${C}/modules?per_page=100&include[]=items&include[]=content_details`]: {
    body: [
      {
        id: 1,
        name: 'Week 1',
        unlock_at: null,
        published: true,
        items: [
          { id: 11, type: 'Page', title: 'Syllabus', html_url: url(`/courses/${C}/modules/items/11`), page_url: 'syllabus', url: url(`/api/v1/courses/${C}/pages/syllabus`) },
          { id: 12, type: 'ExternalTool', title: 'McGraw Hill Connect', html_url: url(`/courses/${C}/modules/items/12`), external_url: 'https://connect.mheducation.com/lti/launch' },
          { id: 13, type: 'ExternalUrl', title: 'Lab kit sign-in', html_url: url(`/courses/${C}/modules/items/13`), external_url: 'https://holscience.com/login' },
          { id: 14, type: 'Assignment', title: 'Lab 3 Report', html_url: url(`/courses/${C}/modules/items/14`), content_id: 101, content_details: { due_at: day(7), unlock_at: day(2), points_possible: 20 } },
          { id: 15, type: 'SubHeader', title: 'Readings' }
        ]
      },
      // Too many items to include: read from its own list.
      { id: 2, name: 'Week 2', unlock_at: day(5), published: true, items_url: url(`/api/v1/courses/${C}/modules/2/items`) }
    ]
  },
  [`/api/v1/courses/${C}/modules/2/items?per_page=100&include[]=content_details`]: { body: [{ id: 21, type: 'File', title: 'Chapter 2 Review Sheet.pdf', html_url: url(`/courses/${C}/modules/items/21`), url: url(`/api/v1/courses/${C}/files/77`), content_details: {} }] },
  '/api/v1/courses?enrollment_state=active&enrollment_type=student&include[]=term&per_page=100': {
    body: [
      { id: C, name: 'General Biology II', course_code: 'BIO 1112-175', workflow_state: 'available', start_at: null, end_at: null, term: { name: 'Fall 2026', start_at: '2026-08-20T06:00:00Z', end_at: '2026-12-15T06:00:00Z' } },
      { id: 556, name: 'Student Orientation', course_code: 'Orientation', workflow_state: 'available', term: { name: 'Default Term' } },
      { id: 557, access_restricted_by_date: true }
    ]
  },
  '/api/v1/conversations?scope=inbox&per_page=50': { body: [{ id: 9100, subject: 'Lab tomorrow', workflow_state: 'unread', last_message: 'Bring goggles', last_message_at: day(-0.5), context_name: 'BIO 1112-175 General Biology II', participants: [{ id: ME, name: 'Student' }, { id: 7, name: 'Dr. Knutsen', full_name: 'Carley Knutsen' }] }] },
  '/api/v1/conversations?scope=sent&per_page=50': { body: [{ id: 9101, subject: 'Question about Lab 3', workflow_state: 'read', last_message: 'Is the template required?', last_message_at: day(-2), context_name: 'BIO 1112-175 General Biology II', participants: [{ id: ME, name: 'Student' }, { id: 7, name: 'Dr. Knutsen' }] }] },
  '/api/v1/conversations/9100?auto_mark_as_read=false': {
    body: {
      id: 9100,
      subject: 'Lab tomorrow',
      participants: [{ id: ME, name: 'Student' }, { id: 7, name: 'Dr. Knutsen', full_name: 'Carley Knutsen' }],
      messages: [
        { id: 2, author_id: 7, created_at: day(-0.5), body: 'Bring goggles. Practice identifying glassware; the practical will have more like these.', attachments: [{ display_name: 'glassware.pdf', url: url('/files/88/download') }] },
        { id: 1, author_id: ME, created_at: day(-1), body: 'Do we need goggles tomorrow?', attachments: [] }
      ]
    }
  },
  [`/api/v1/search/recipients?search=${encodeURIComponent('Carley Knutsen')}&context=course_${C}&type=user&per_page=10`]: { body: [{ id: 7, name: 'Carley Knutsen', full_name: 'Carley Knutsen' }] },
  [`/api/v1/search/recipients?search=${encodeURIComponent('Smith')}&context=course_${C}&type=user&per_page=10`]: { body: [{ id: 8, name: 'Ann Smith' }, { id: 9, name: 'Bob Smith' }] }
};

/** The calendar events route has times in it: matched by prefix. */
const calendar = { prefix: `/api/v1/calendar_events?type=event&context_codes[]=course_${C}&`, body: [{ id: 3001, title: 'Lab practical', start_at: day(9), end_at: day(9.1), location_name: 'Room 204' }] };

module.exports = { HOST, C, ME, routes, calendar, assignments };
