import bcrypt from "bcrypt";
import {
  User,
  Department,
  Position,
} from "./userModel.js";
import {
  CourseCategory,
  Course,
  Module,
  Lesson,
  LessonContent,
} from "./courseModel.js";
import {
  QuestionBank,
  Question,
  QuestionOption,
  Assessment,
} from "./assessmentModel.js";
import { Notification, ActivityLog } from "./platformModel.js";
import { generateQuestions } from "../services/questionGenerator.js";

const htmlEscape = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function buildLessonContent(sections) {
  const html = sections
    .map(
      (section, index) => `
    <section class="lesson-section" id="section-${index + 1}">
      <h2>${htmlEscape(section.heading)}</h2>
      ${section.paragraphs.map((p) => `<p>${htmlEscape(p)}</p>`).join("\n")}
    </section>`
    )
    .join("\n");
  const plainText = sections
    .map((s) => `${s.heading}\n${s.paragraphs.join("\n")}`)
    .join("\n\n");
  return { html, plainText };
}

const COURSES = [
  {
    title: "Workplace Safety & Onboarding",
    category: "Onboarding",
    description:
      "Everything a new Vanguard colleague needs in the first week: our mission, communication norms, health and safety, and information security essentials.",
    objectives:
      "Understand company values and conduct expectations; respond correctly to workplace emergencies; protect company and customer information.",
    level: "beginner",
    durationHours: 3,
    accent: "#0f766e",
    modules: [
      {
        title: "Getting Started",
        description: "Welcome to Vanguard and your first week.",
        lessons: [
          {
            title: "Welcome to the Company",
            sections: [
              {
                heading: "Our Mission and Values",
                paragraphs: [
                  "Vanguard Solutions builds reliable technology services for customers across the Philippines. Our mission is to deliver dependable service while treating every colleague and customer with respect. Integrity, accountability, and customer focus guide every decision we make.",
                  "Every team publishes quarterly goals that connect daily work to the company mission. Colleagues are expected to raise risks early and to support one another during busy periods.",
                ],
              },
              {
                heading: "Your First Week",
                paragraphs: [
                  "Your first week introduces you to your team, your tools, and the Vanguard way of working. Your people manager will schedule an onboarding plan that covers access requests, payroll enrollment, and mandatory training. Complete the onboarding checklist within your first five working days.",
                  "Your buddy is available for questions about routines, tools, and company culture. Ask your people manager for an introduction if a buddy has not been assigned.",
                ],
              },
              {
                heading: "How We Communicate",
                paragraphs: [
                  "Vanguard uses Microsoft Teams for daily collaboration and email for formal communication. Weekly team meetings review priorities, risks, and customer commitments. Report urgent issues in the incident channel so the response team can act quickly.",
                  "Keep meeting notes in the shared team workspace. Written decisions help colleagues who work across different time zones stay aligned.",
                ],
              },
              {
                heading: "Code of Conduct",
                paragraphs: [
                  "Every employee must follow the Vanguard code of conduct. The code prohibits harassment, discrimination, and conflicts of interest. Speak to Human Resources immediately if you experience or witness unacceptable behavior.",
                  "Gifts and outside work must be disclosed when they could influence a business decision. The compliance team reviews disclosures confidentially.",
                ],
              },
            ],
          },
          {
            title: "Health and Safety Essentials",
            sections: [
              {
                heading: "Emergency Preparedness",
                paragraphs: [
                  "Every Vanguard office displays evacuation maps beside each elevator lobby. The fire warden directs evacuation to the assembly area during an emergency. Never use the elevator during a fire alarm; use the nearest fire exit.",
                  "Keep the walkway beside each emergency exit clear at all times. Report blocked exits to the facilities team immediately.",
                ],
              },
              {
                heading: "Fire Safety",
                paragraphs: [
                  "A fire extinguisher uses the PASS technique: pull the pin, aim at the base, squeeze the handle, and sweep side to side. Only attempt to extinguish a small fire when you have a clear escape route. Call the emergency hotline before fighting any fire.",
                  "Fire drills are scheduled twice each year. Everyone must participate in the fire drill even when the alarm is announced in advance.",
                ],
              },
              {
                heading: "Reporting Incidents",
                paragraphs: [
                  "Report every workplace injury, near miss, and unsafe condition in the safety portal within twenty-four hours. The safety officer investigates incidents and assigns corrective actions. Employees may report concerns anonymously without fear of retaliation.",
                  "A near miss is an event that could have caused harm but did not. Reporting a near miss helps the safety officer remove the hazard before someone is injured.",
                ],
              },
              {
                heading: "Ergonomics and Wellbeing",
                paragraphs: [
                  "Adjust your chair so your feet rest flat on the floor and your screen sits at eye level. Take a short movement break every hour to reduce fatigue. Request an ergonomic assessment if you feel persistent discomfort.",
                  "The employee assistance program offers confidential counselling for work and personal concerns. Contact Human Resources to request support.",
                ],
              },
            ],
          },
        ],
      },
      {
        title: "Working Securely",
        description: "Protect accounts, data, and the workplace.",
        lessons: [
          {
            title: "Information Security at Work",
            sections: [
              {
                heading: "Passwords and Authentication",
                paragraphs: [
                  "Use a unique passphrase for every Vanguard account and store it in the approved password manager. Multi-factor authentication is mandatory for email, VPN, and administrative systems. Never share credentials or approve an authentication prompt you did not initiate.",
                  "Report a lost device to the service desk immediately so the security team can disable access and remote wipe the device.",
                ],
              },
              {
                heading: "Phishing Awareness",
                paragraphs: [
                  "Phishing messages often create urgency and ask you to click a link or open an attachment. Verify the sender address before responding to any request for credentials or payment. Report suspicious email with the Report Phishing button so the security team can investigate.",
                  "The security team never asks for your password by email or phone. When in doubt, contact the service desk using the number on the company intranet.",
                ],
              },
              {
                heading: "Data Classification",
                paragraphs: [
                  "Vanguard classifies information as public, internal, confidential, or restricted. Store confidential and restricted data only in approved company systems. Encrypt restricted data before sending it outside the company network.",
                  "Share information on a need-to-know basis. Confirm the recipient and the retention period before sending confidential records.",
                ],
              },
              {
                heading: "Clean Desk and Clear Screen",
                paragraphs: [
                  "Lock your workstation whenever you leave your desk, even for a short break. Remove printed confidential documents from the printer immediately. A clean desk reduces the risk of information theft.",
                  "Use the privacy filter on laptops when working in public spaces. Avoid discussing confidential matters on speakerphone where others can overhear.",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "Networking Fundamentals",
    category: "IT & Networking",
    description:
      "A practical foundation in the OSI model, IPv4 addressing, switching, and routing for IT support and infrastructure staff.",
    objectives:
      "Describe the seven OSI layers; plan and troubleshoot IPv4 addressing; explain switching and routing decisions.",
    level: "intermediate",
    durationHours: 6,
    accent: "#1d4ed8",
    modules: [
      {
        title: "Network Models",
        description: "How networks are structured and described.",
        lessons: [
          {
            title: "The OSI Reference Model",
            sections: [
              {
                heading: "The Seven Layers",
                paragraphs: [
                  "The Open Systems Interconnection model divides network communication into seven layers. Each layer provides a specific service to the layer above it. The model helps engineers describe, troubleshoot, and design networks.",
                  "The seven layers are Physical, Data Link, Network, Transport, Session, Presentation, and Application. Memorizing the order makes it easier to isolate a network fault.",
                ],
              },
              {
                heading: "Lower Layers",
                paragraphs: [
                  "The Physical layer transmits raw bits across copper cable, fiber optics, or a wireless medium. The Data Link layer groups bits into frames and detects transmission errors. The Network layer handles logical addressing and routes packets between networks.",
                  "A faulty cable, a damaged switch port, or a weak wireless signal is a Physical layer problem. A duplicate IP address is usually a Network layer problem.",
                ],
              },
              {
                heading: "Upper Layers",
                paragraphs: [
                  "The Transport layer provides end-to-end delivery using the Transmission Control Protocol or the User Datagram Protocol. The Session layer establishes and terminates communication sessions between applications. The Application layer delivers network services directly to users.",
                  "The Presentation layer handles data formats, encryption, and compression. A certificate error in a browser often points to a Presentation layer issue.",
                ],
              },
              {
                heading: "Encapsulation",
                paragraphs: [
                  "Encapsulation wraps data with protocol information as it moves down the network stack. Each layer adds a header that the receiving peer removes as data moves back up the stack. Troubleshooting the correct layer narrows the cause of a network fault.",
                  "A protocol data unit at the Transport layer is called a segment. At the Network layer it is called a packet, and at the Data Link layer it is called a frame.",
                ],
              },
            ],
          },
        ],
      },
      {
        title: "Addressing and Routing",
        description: "IPv4 addressing, switching, and routing.",
        lessons: [
          {
            title: "IPv4 Addressing Basics",
            sections: [
              {
                heading: "Address Structure",
                paragraphs: [
                  "An IPv4 address is a thirty-two-bit number written as four decimal octets. The subnet mask separates the network portion of the address from the host portion. Devices on the same subnet communicate directly without a router.",
                  "The default gateway is the router address a host uses to reach a different subnet. A host with an incorrect gateway can reach local devices but not the Internet.",
                ],
              },
              {
                heading: "Private and Public Ranges",
                paragraphs: [
                  "Private IPv4 ranges include 10.0.0.0/8, 172.16.0.0/12, and 192.168.0.0/16. Private addresses are not routable on the public Internet and require network address translation. Public addresses are assigned by regional internet registries.",
                  "Network address translation allows many private hosts to share one public address. Port address translation tracks each session so replies return to the correct host.",
                ],
              },
              {
                heading: "DHCP and DNS",
                paragraphs: [
                  "The Dynamic Host Configuration Protocol automatically supplies an IP address, subnet mask, default gateway, and DNS server. The Domain Name System translates a host name into an IP address. A misconfigured DNS server commonly causes name resolution failures.",
                  "A DHCP scope defines the range of addresses a server can lease. Lease duration controls how long a client may keep an address before renewing it.",
                ],
              },
              {
                heading: "Subnetting",
                paragraphs: [
                  "Subnetting borrows bits from the host portion to create smaller networks. Classless Inter-Domain Routing notation records the number of network bits after a slash. Careful subnet planning reduces broadcast traffic and improves security.",
                  "Each subnet reserves a network address and a broadcast address. The usable host addresses are the addresses between those two values.",
                ],
              },
            ],
          },
          {
            title: "Routing and Switching",
            sections: [
              {
                heading: "Switches and MAC Addresses",
                paragraphs: [
                  "A network switch forwards Ethernet frames using the destination MAC address. The switch learns MAC addresses by recording the source address of incoming frames. A virtual local area network separates broadcast domains on the same switch.",
                  "A trunk link carries traffic for multiple virtual local area networks between switches. Access ports usually carry traffic for a single virtual local area network.",
                ],
              },
              {
                heading: "Routers and Routes",
                paragraphs: [
                  "A router forwards packets between different IP networks using its routing table. A default route sends unknown destinations toward the next upstream router. A static route is manually configured and does not adapt automatically to failures.",
                  "The longest prefix match rule chooses the most specific route in the routing table. A route with a smaller metric is preferred when two routes have the same prefix length.",
                ],
              },
              {
                heading: "Dynamic Routing",
                paragraphs: [
                  "Dynamic routing protocols exchange reachability information between routers. The Open Shortest Path First protocol calculates the shortest path using link costs. Routing convergence restores connectivity after a link failure.",
                  "The Border Gateway Protocol exchanges routes between autonomous systems on the Internet. Route filtering prevents an organization from advertising private ranges.",
                ],
              },
              {
                heading: "Troubleshooting",
                paragraphs: [
                  "Start network troubleshooting at the physical layer and work upward through the OSI model. Verify the link status, IP configuration, default gateway, and DNS resolution in that order. Document the resolution so the team can reuse the fix.",
                  "Use ping to test reachability, traceroute to locate a failing hop, and nslookup to test name resolution. Compare the result with a known working device on the same subnet.",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "Data Privacy & Compliance",
    category: "Compliance",
    description:
      "How Vanguard handles personal data, responds to data subject requests, and manages a personal data breach under the Data Privacy Act.",
    objectives:
      "Apply privacy principles; handle data subject requests; respond to and report a personal data breach.",
    level: "beginner",
    durationHours: 2,
    accent: "#7c3aed",
    // Paid course: learners must complete a verified purchase to enroll.
    price: 2250,
    modules: [
      {
        title: "Handling Personal Data",
        description: "Privacy principles and data subject rights.",
        lessons: [
          {
            title: "Privacy Principles",
            sections: [
              {
                heading: "Lawful Processing",
                paragraphs: [
                  "The Data Privacy Act requires Vanguard to collect only personal data that is necessary for a legitimate purpose. Personal data must be processed fairly, lawfully, and transparently. Retain personal data only for the period required by law or business need.",
                  "Obtain consent when consent is the chosen legal basis, and record how and when consent was given. Consent may be withdrawn at any time.",
                ],
              },
              {
                heading: "Data Subject Rights",
                paragraphs: [
                  "Individuals have the right to access, correct, and object to the processing of their personal data. Respond to a data subject request within fifteen working days. Verify the identity of the requester before disclosing any personal data.",
                  "A data subject may also request erasure or blocking when the data is no longer necessary. Human Resources and the Data Protection Officer review every request.",
                ],
              },
              {
                heading: "Sharing Personal Data",
                paragraphs: [
                  "Share personal data with a third party only under a written data processing agreement. Transfer restricted personal data using an approved encrypted channel. Record the legal basis and purpose of every disclosure.",
                  "A data processing agreement must state the security controls and breach notification duties of the processor. The procurement team checks the agreement before onboarding a supplier.",
                ],
              },
              {
                heading: "Privacy by Design",
                paragraphs: [
                  "Privacy by design embeds data protection into every system and process. Collect the minimum data required and anonymize it whenever possible. Review new features for privacy risks before release.",
                  "A privacy impact assessment documents the data flows and risks of a new system. Complete the assessment before production data is loaded.",
                ],
              },
            ],
          },
          {
            title: "Responding to a Data Breach",
            sections: [
              {
                heading: "Recognizing a Breach",
                paragraphs: [
                  "A personal data breach includes unauthorized access, accidental disclosure, loss, or alteration of personal data. Contain the breach immediately by disabling compromised accounts and isolating affected systems. Preserve evidence for the investigation.",
                  "Do not delete logs or reformat a compromised device. The incident response team needs the evidence to determine the scope.",
                ],
              },
              {
                heading: "Notification Duties",
                paragraphs: [
                  "Notify the Data Protection Officer within twenty-four hours of discovering a personal data breach. The Data Protection Officer assesses whether regulators and affected individuals must be informed. Document the facts, impact, and remediation in the breach register.",
                  "The Data Privacy Act requires notification when the breach poses a real risk of serious harm. The Data Protection Officer makes that determination with legal counsel.",
                ],
              },
              {
                heading: "Lessons Learned",
                paragraphs: [
                  "Conduct a post-incident review after every confirmed personal data breach. Identify the root cause and update controls to prevent recurrence. Share approved lessons with teams without exposing confidential details.",
                  "Track corrective actions to completion and report the status to the compliance committee. A repeated finding signals that the control is not effective.",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "Leading High-Performance Teams",
    category: "Leadership",
    description:
      "Practical coaching, feedback, and delegation skills for new and experienced people managers.",
    objectives:
      "Run effective coaching conversations; deliver specific feedback; delegate outcomes with clear authority.",
    level: "intermediate",
    durationHours: 2,
    accent: "#b45309",
    price: 1499,
    modules: [
      {
        title: "Coaching Essentials",
        description: "Everyday conversations that develop people.",
        lessons: [
          {
            title: "Coaching and Feedback",
            sections: [
              {
                heading: "Coaching Conversations",
                paragraphs: [
                  "Effective managers coach their team through regular one-on-one conversations. Ask open questions that help the employee identify the next action. Focus on observable behavior rather than personal characteristics.",
                  "Keep a shared running agenda so the employee can raise topics before the meeting. Coaching conversations work best when they happen consistently, not only during performance reviews.",
                ],
              },
              {
                heading: "Feedback That Works",
                paragraphs: [
                  "Deliver specific feedback close to the event and describe its impact. Recognize strong performance publicly and address sensitive issues privately. Agree on a clear follow-up date to review progress.",
                  "Ask the employee for their perspective before offering your own. A two-way feedback conversation is more likely to produce a real commitment.",
                ],
              },
              {
                heading: "Delegation",
                paragraphs: [
                  "Delegation develops capability by transferring ownership of an outcome with clear authority. Explain the expected result, constraints, and decision boundaries. Check in at agreed milestones rather than taking the task back.",
                  "Match the level of support to the employee's experience. A new employee needs more frequent checkpoints than a trusted expert.",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    title: "HR Essentials: Employee Lifecycle",
    category: "HR Essentials",
    description:
      "A concise guide to recruitment, onboarding, performance conversations, and offboarding for HR staff.",
    objectives:
      "Run a compliant onboarding process; support performance conversations; complete offboarding controls.",
    level: "beginner",
    durationHours: 2,
    accent: "#be123c",
    modules: [
      {
        title: "The Employee Journey",
        description: "From offer to exit.",
        lessons: [
          {
            title: "Supporting the Employee Journey",
            sections: [
              {
                heading: "Recruitment and Onboarding",
                paragraphs: [
                  "The employee lifecycle begins with workforce planning and a documented recruitment process. Every new hire receives a written offer and a structured onboarding plan. Human Resources verifies identity and statutory documents before the start date.",
                  "The onboarding plan assigns a buddy, a people manager, and a set of required training courses. Human Resources confirms completion during the first month.",
                ],
              },
              {
                heading: "Performance and Development",
                paragraphs: [
                  "Managers hold a performance conversation with each employee at least twice a year. Development goals should connect individual growth with business priorities. Human Resources provides learning resources and tracks required training.",
                  "Training compliance is reviewed monthly for every department. Overdue training is escalated to the employee and the people manager.",
                ],
              },
              {
                heading: "Offboarding",
                paragraphs: [
                  "Offboarding begins when an employee resigns or a role ends. Recover company assets, revoke system access, and conduct an exit interview. Human Resources retains employment records for the period required by regulation.",
                  "Revoke system access on the final working day and confirm the change with the security team. An exit interview identifies patterns that can improve retention.",
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

function bootstrapPassword(variable, developmentFallback) {
  const value = process.env[variable];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${variable} is required to create the initial staff accounts.`);
  }
  return developmentFallback;
}

async function createUser({ name, email, password, role, departmentId, positionId, employeeId, employmentStatus = "active", dateHired }) {
  const hashed = await bcrypt.hash(password, 10);
  return User.create({
    name,
    email,
    password: hashed,
    role,
    departmentId,
    positionId,
    employeeId,
    employmentStatus,
    dateHired,
    avatarColor: ["#1d4ed8", "#0f766e", "#7c3aed", "#b45309", "#be123c"][
      Math.floor(Math.random() * 5)
    ],
  });
}

async function createLessonBank({ lesson, course, sections, batch, instructor }) {
  const { html, plainText } = buildLessonContent(sections);
  await LessonContent.create({ lessonId: lesson.id, html, plainText, sections: JSON.stringify(sections) });

  const bank = await QuestionBank.create({
    lessonId: lesson.id,
    courseId: course.id,
    title: `${lesson.title} — Question Bank`,
    status: "approved",
    generator: "ai_local",
  });

  const generated = await generateQuestions({ text: plainText, count: 16 });
  let index = 0;
  for (const q of generated.questions) {
    const question = await Question.create({
      bankId: bank.id,
      lessonId: lesson.id,
      type: q.type,
      prompt: q.prompt,
      explanation: q.explanation,
      sourceRef: q.sourceRef,
      difficulty: q.difficulty,
      // The first lesson keeps some drafts so instructors can see the review queue.
      status: batch === 0 && index >= 10 ? "pending" : "approved",
      generatedBy: "ai",
      orderIndex: index,
    });
    await QuestionOption.bulkCreate(
      q.options.map((option, optionIndex) => ({
        questionId: question.id,
        text: option.text,
        isCorrect: option.isCorrect,
        orderIndex: optionIndex,
      }))
    );
    index += 1;
  }

  await Assessment.create({
    courseId: course.id,
    lessonId: lesson.id,
    title: `${lesson.title} — Knowledge Check`,
    type: "lesson_gate",
    questionCount: course.questionCount,
    passScore: course.passScore,
    maxAttempts: course.maxAttempts,
    showExplanations: course.showExplanations,
  });

  return { bank, plainText };
}

export async function seedDatabase() {
  const existing = await User.count();
  if (existing > 0) return false;

  // Validate bootstrap credentials before creating any dependent rows, so a
  // misconfigured production start cannot leave a half-seeded database.
  const adminPassword = bootstrapPassword("BOOTSTRAP_ADMIN_PASSWORD", "Admin@123");
  const hrPassword = bootstrapPassword("BOOTSTRAP_HR_PASSWORD", "Hr@123");
  const instructorPassword = bootstrapPassword(
    "BOOTSTRAP_INSTRUCTOR_PASSWORD",
    "Teach@123"
  );

  const it = await Department.create({
    name: "Information Technology",
    code: "IT",
    description: "Infrastructure, applications, and service delivery",
  });
  const hr = await Department.create({
    name: "Human Resources",
    code: "HR",
    description: "People operations and learning",
  });
  const ops = await Department.create({
    name: "Operations",
    code: "OPS",
    description: "Service operations and customer delivery",
  });

  await Position.create({
    title: "IT Support Specialist",
    departmentId: it.id,
  });
  await Position.create({
    title: "Software Engineer",
    departmentId: it.id,
  });
  const hrOfficer = await Position.create({
    title: "HR Officer",
    departmentId: hr.id,
    requiredCourseIds: "[]",
  });
  const ldLead = await Position.create({
    title: "Learning & Development Lead",
    departmentId: hr.id,
  });
  const opsManager = await Position.create({
    title: "Operations Manager",
    departmentId: ops.id,
  });
  void opsManager;

  const categories = {};
  for (const name of [
    "Onboarding",
    "IT & Networking",
    "Compliance",
    "Leadership",
    "HR Essentials",
  ]) {
    const row = await CourseCategory.create({
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    });
    categories[name] = row;
  }

  const admin = await createUser({
    name: "System Administrator",
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@lms.test",
    password: adminPassword,
    role: "superadmin",
  });
  const hrUser = await createUser({
    name: "Liza Mercado",
    email: process.env.BOOTSTRAP_HR_EMAIL || "hr@lms.test",
    password: hrPassword,
    role: "hr",
    departmentId: hr.id,
    positionId: hrOfficer.id,
    employeeId: "EMP-1000",
    dateHired: "2024-06-03",
  });
  const instructor = await createUser({
    name: "Engr. Maria Santos",
    email: process.env.BOOTSTRAP_INSTRUCTOR_EMAIL || "instructor@lms.test",
    password: instructorPassword,
    role: "instructor",
    departmentId: hr.id,
    positionId: ldLead.id,
    employeeId: "EMP-1001",
    dateHired: "2024-08-12",
  });

  const courses = {};
  for (const definition of COURSES) {
    const course = await Course.create({
      title: definition.title,
      description: definition.description,
      categoryId: categories[definition.category].id,
      instructorId: instructor.id,
      objectives: definition.objectives,
      durationHours: definition.durationHours,
      level: definition.level,
      accent: definition.accent,
      price: definition.price || 0,
      currency: "PHP",
      status: "published",
      questionCount: 5,
      passScore: 4,
      allowRetakes: true,
      showExplanations: true,
      certificateEnabled: true,
    });
    courses[definition.title] = course;

    const onboarding = definition.title === "Workplace Safety & Onboarding";
    let batch = 0;
    for (let m = 0; m < definition.modules.length; m += 1) {
      const moduleDefinition = definition.modules[m];
      const mod = await Module.create({
        courseId: course.id,
        title: moduleDefinition.title,
        description: moduleDefinition.description,
        orderIndex: m,
      });
      for (let l = 0; l < moduleDefinition.lessons.length; l += 1) {
        const lessonDefinition = moduleDefinition.lessons[l];
        const lesson = await Lesson.create({
          courseId: course.id,
          moduleId: mod.id,
          title: lessonDefinition.title,
          summary: lessonDefinition.sections[0].paragraphs[0].slice(0, 180),
          orderIndex: l,
          durationMinutes: 20,
          status: "published",
          sourceName: `${lessonDefinition.title}.pdf`,
          sourceMime: "application/pdf",
        });
        await createLessonBank({
          lesson,
          course,
          sections: lessonDefinition.sections,
          batch,
          instructor,
        });
        batch += 1;
      }
    }
  }

  // Position-based automatic training requirements.
  const networking = courses["Networking Fundamentals"];
  const privacy = courses["Data Privacy & Compliance"];
  const leadership = courses["Leading High-Performance Teams"];
  const hrCourse = courses["HR Essentials: Employee Lifecycle"];
  await itSupport.update({ requiredCourseIds: JSON.stringify([networking.id]) });
  await dev.update({ requiredCourseIds: JSON.stringify([networking.id]) });
  await opsManager.update({ requiredCourseIds: JSON.stringify([leadership.id]) });
  await hrOfficer.update({ requiredCourseIds: JSON.stringify([hrCourse.id, privacy.id]) });
  await ldLead.update({ requiredCourseIds: JSON.stringify([privacy.id]) });

  const onboardingCourse = courses["Workplace Safety & Onboarding"];

  const onboardingFirstLesson = await Lesson.findOne({
    where: { courseId: onboardingCourse.id },
    order: [
      ["orderIndex", "ASC"],
      ["id", "ASC"],
    ],
  });

  await Notification.create({
    userId: instructor.id,
    title: "Question bank ready for review",
    message:
      "AI-assisted questions were generated for Welcome to the Company. Review and approve them before publishing.",
    type: "question_bank",
    link: onboardingFirstLesson
      ? `/instructor/lessons/${onboardingFirstLesson.id}/questions`
      : "/instructor/courses",
  });

  await ActivityLog.bulkCreate([
    { userId: admin.id, action: "Initial data installed", entityType: "system", detail: "Initial LMS data created", ip: "127.0.0.1" },
    { userId: instructor.id, action: "Published course", entityType: "course", entityId: onboardingCourse.id, detail: onboardingCourse.title, ip: "127.0.0.1" },
  ]);

  console.log("✅ LMS initial data seeded (staff accounts and course catalogue)");
  return true;
}
