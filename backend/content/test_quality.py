"""Quality intelligence tests: deterministic, offline, with English, Telugu and Tinglish examples."""

from django.test import TestCase

from users.models import User
from x_accounts.models import ContentDNA, XAccount

from . import quality, services
from .checks import normalize_text, similarity
from .models import ContentItem
from .prompts import SYSTEM_PROMPT, build_user_prompt
from .providers import Candidate
from .quality import History, detect_language, option_plan, quality_flags
from .test_generation import DNA, FixedProvider

TELUGU_DNA = {**DNA, 'languages': ['TELUGU'], 'tone': ['Reflective', 'Warm'], 'primary_themes': ['Telugu cinema'], 'secondary_themes': []}


def codes(flags):
    return [f['code'] for f in flags]


class LanguageDetectionTests(TestCase):
    def test_realistic_examples(self):
        cases = {
            'Test cricket rewards patience in a way T20 never will.': 'ENGLISH',
            'Uppal pitch slows down after the dew sets in, so chasing there is a gamble.': 'ENGLISH',
            'Ee weekend plans enti? Biryani aa leka cinema aa?': 'TINGLISH',
            'Powerplay lo first over chusthe match mood telisipothundi.': 'TINGLISH',
            'Last over lo tension aagadu asalu, TV mute chesi chusthunna.': 'TINGLISH',
            'ఈ వారం ఏ సినిమా చూస్తున్నారు?': 'TELUGU',
            'OTT లో ఈ వారం ఏ సినిమా బాగుంది?': 'TELUGU',  # English words inside Telugu are normal
            'వర్షం పడితే చాయ్, పకోడీ తప్ప ఇంకేం కావాలి?': 'TELUGU',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(detect_language(text), expected)

    def test_stays_silent_when_unsure(self):
        # Short text, a lone Telugu-looking word in English, or real script mixing: no guess, so no false warning.
        for text in ['Super innings!', 'Lo and behold, the rain stopped play again at Uppal.', 'Kohli ki century — what a knock తెలుసా', '🏏🔥']:
            with self.subTest(text=text):
                self.assertEqual(detect_language(text), '')


class TeluguNormalizationTests(TestCase):
    def test_telugu_words_stay_whole(self):
        # Vowel signs are combining marks; dropping them used to split every Telugu word into letters.
        self.assertEqual(normalize_text('ఈ వారం ఏ సినిమా చూస్తున్నారు?'), 'ఈ వారం ఏ సినిమా చూస్తున్నారు')
        self.assertGreater(similarity('ఈ వారం ఏ సినిమా చూస్తున్నారు?', 'ఈ వారం ఏ సినిమా చూస్తారు?'), 0)

    def test_similar_telugu_posts_are_flagged_as_duplicates(self):
        user = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        account = XAccount.objects.create(handle='om2_cinema', display_name='Cinema')
        ContentDNA.objects.create(x_account=account, **TELUGU_DNA)
        first = 'వర్షం పడితే చాయ్ పకోడీ సినిమా తప్ప ఇంకేం కావాలి'
        second = 'వర్షం పడితే చాయ్ పకోడీ సినిమా ఇంకేం కావాలి చెప్పండి'
        services.create_manual(account, user, fmt='TEXT', body=first, language='TELUGU')
        item = services.create_manual(account, user, fmt='TEXT', body=second, language='TELUGU')
        self.assertEqual(item.duplicate_flags[0]['kind'], 'SIMILAR')


class QualityFlagTests(TestCase):
    def check(self, text, fmt='TEXT', language='', dna=DNA, history=None, **kw):
        return codes(quality_flags(fmt, text, language=language, dna=dna, history=history, **kw))

    def test_natural_posts_in_each_language_pass_cleanly(self):
        self.assertEqual(self.check('Uppal pitch slows down after the dew sets in, so chasing there is a gamble.', language='ENGLISH'), [])
        self.assertEqual(self.check('Powerplay lo first over chusthe match mood telisipothundi.', language='TINGLISH'), [])
        self.assertEqual(self.check('వర్షం పడితే చాయ్, పకోడీ తప్ప ఇంకేం కావాలి?', language='TELUGU', dna=TELUGU_DNA), [])
        self.assertEqual(self.check('Best death-over bowler this season?', fmt='POLL', language='ENGLISH'), [])

    def test_generic_phrases_are_named(self):
        flags = quality_flags('TEXT', 'Hot take: at the end of the day, cricket is a game changer for everyone.', language='ENGLISH', dna=DNA)
        generic = next(f for f in flags if f['code'] == 'GENERIC_PHRASE')
        self.assertIn('“hot take”, “game changer”, “at the end of the day”', generic['message'])

    def test_engagement_bait_in_english_tinglish_and_telugu(self):
        for text, language in [
            ('Kohli or Rohit for the final over? Like if you agree with Kohli!', 'ENGLISH'),
            ('Ee match lo best player evaru? Comment cheyandi.', 'TINGLISH'),
            ('మీకు ఇష్టమైన పాట ఏది? కామెంట్ చేయండి.', 'TELUGU'),
        ]:
            with self.subTest(text=text):
                self.assertIn('ENGAGEMENT_BAIT', self.check(text, language=language, dna={**DNA, 'languages': ['ENGLISH', 'TINGLISH', 'TELUGU']}))

    def test_language_mismatches_explain_what_to_do(self):
        flags = quality_flags('TEXT', 'The last over of a close chase is the best part of any T20 game.', language='TINGLISH', dna=DNA)
        self.assertEqual(flags[0]['code'], 'LANGUAGE_MISMATCH')
        self.assertIn('Marked Tinglish but reads as English. Use Telugu in English letters', flags[0]['message'])
        self.assertIn('LANGUAGE_MISMATCH', self.check('ఈ వారం ఏ సినిమా చూస్తున్నారు?', language='TINGLISH'))
        self.assertIn('LANGUAGE_MISMATCH', self.check('Ee weekend plans enti? Biryani aa leka cinema aa?', language='ENGLISH'))

    def test_language_outside_the_dna(self):
        flags = quality_flags('TEXT', 'ఈ వారం ఏ సినిమా చూస్తున్నారు?', dna=DNA)  # DNA: English and Tinglish
        self.assertEqual(flags[0]['message'], 'Reads as Telugu, which isn’t one of this account’s languages (English, Tinglish).')

    def test_low_specificity(self):
        self.assertIn('LOW_SPECIFICITY', self.check('Life is good when you just keep going every day.', language='ENGLISH'))
        self.assertNotIn('LOW_SPECIFICITY', self.check('Spinners at Chepauk win games by the 15th over, not the last.', language='ENGLISH'))

    def test_hashtags_emoji_and_off_dna_themes(self):
        self.assertIn('HASHTAG_AGAINST_DNA', self.check('Chepauk turners are back #IPL', language='ENGLISH'))  # DNA says "No hashtags."
        self.assertNotIn('HASHTAG_AGAINST_DNA', self.check('Chepauk turners are back #IPL', dna={**DNA, 'additional_instructions': ''}))
        self.assertIn('MANY_EMOJI', self.check('Match day 🏏🔥🔥🎉 lets go'))
        self.assertIn('THEME_NOT_IN_DNA', self.check('Chepauk turners are back again', theme='Politics', is_ai=True))
        self.assertNotIn('THEME_NOT_IN_DNA', self.check('Chepauk turners are back again', theme='Politics'))  # manual posts may set any theme

    def test_repeated_and_common_openings(self):
        history = History(
            recent_posts=('Ee weekend plans enti? Cinema aa?',),
            network_openings={'nobody talks about': 3, 'last over lo': 1},
        )
        self.assertIn('REPEATED_OPENING', self.check('Ee weekend plans lo biryani undali.', history=history))
        flags = quality_flags('TEXT', 'Nobody talks about how slow the Uppal outfield is.', dna=DNA, history=history)
        self.assertEqual(flags[-1]['message'], '3 other accounts recently opened with “nobody talks about…”. Vary it so accounts don’t sound alike.')
        self.assertNotIn('COMMON_OPENING', self.check('Last over lo tension aagadu asalu.', history=history))  # one account only

    def test_repetitive_structure(self):
        questions = History(recent_text_posts=('Best spinner?', 'Who opens?', 'Tea or coffee at stumps?', 'Why Uppal?', 'Rain again.'))
        self.assertIn('REPETITIVE_STRUCTURE', self.check('Which ground has the best biryani stall?', history=questions))
        self.assertNotIn('REPETITIVE_STRUCTURE', self.check('Uppal pitch slows down after the dew sets in, so chasing there is a gamble.', history=questions))
        self.assertNotIn('REPETITIVE_STRUCTURE', self.check('Which ground has the best biryani stall?', fmt='POLL', history=questions))


class OptionPlanTests(TestCase):
    def test_each_option_gets_a_distinct_angle_and_rotated_theme_and_language(self):
        plan = option_plan('om2_cricket', DNA, 5)
        self.assertEqual(len({angle for _, _, angle in plan}), 5)
        self.assertEqual([t for t, _, _ in plan], ['Cricket', 'Telugu cinema', 'Hyderabad food', 'Cricket', 'Telugu cinema'])
        self.assertEqual({lang for _, lang, _ in plan}, {'ENGLISH', 'TINGLISH'})

    def test_tone_shapes_the_angles(self):
        witty = {a for _, _, a in option_plan('a', {**DNA, 'tone': ['Witty']}, 3)}
        reflective = {a for _, _, a in option_plan('a', {**DNA, 'tone': ['Reflective']}, 2)}
        self.assertTrue(witty <= {a[1] for a in quality.ANGLES if 'witty' in a[2]})
        self.assertTrue(reflective <= {a[1] for a in quality.ANGLES if 'reflective' in a[2]})

    def test_least_used_themes_come_first(self):
        history = History(theme_counts={'Cricket': 6, 'Telugu cinema': 1})
        self.assertEqual(option_plan('om2_cricket', DNA, 1, history)[0][0], 'Telugu cinema')

    def test_deterministic_but_different_across_accounts_and_batches(self):
        self.assertEqual(option_plan('om2_cricket', DNA, 3), option_plan('om2_cricket', DNA, 3))
        plans = {tuple(option_plan(handle, DNA, 3)) for handle in ['om2_cricket', 'hyd_foodie', 'tollywood_talk', 'chepauk_fan']}
        self.assertGreater(len(plans), 1)
        self.assertNotEqual(option_plan('om2_cricket', DNA, 3), option_plan('om2_cricket', DNA, 3, History(batch_number=1)))


class PromptTests(TestCase):
    def test_prompt_is_focused_and_compact(self):
        long_posts = [f'Post {i}: ' + 'a fairly long observation about cricket and cinema ' * 5 for i in range(15)]
        history = History(recent_posts=tuple(long_posts), network_openings={'nobody talks about': 4, 'rare opening here': 1})
        prompt = build_user_prompt('om2_cricket', DNA, 3, '', 'Focus on the weekend', long_posts, history)
        self.assertIn('Languages: English, Tinglish', prompt)
        self.assertIn('Tinglish: Telugu in English letters', prompt)
        self.assertNotIn('Telugu: natural spoken Telugu', prompt)  # only the account's languages
        self.assertEqual(prompt.count('\n- Post '), 10)  # recent posts capped and shortened
        self.assertTrue(all(len(line) <= 112 for line in prompt.splitlines() if line.startswith('- Post ')))
        self.assertIn('"nobody talks about"', prompt)
        self.assertNotIn('rare opening here', prompt)
        self.assertIn('Plan (one option per line, all genuinely different):\n1. ', prompt)
        self.assertTrue(prompt.endswith('Write 3 options.'))
        self.assertLess(len(prompt), 2600)

    def test_system_prompt_no_longer_halves_telugu_posts(self):
        # X counts Telugu letters as one character each, like Latin letters.
        self.assertNotIn('140', SYSTEM_PROMPT)


class GenerationQualityTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username='boss', password='x', role=User.Role.MILLIONAIRE)
        self.account = XAccount.objects.create(handle='om2_cricket', display_name='Cricket')
        ContentDNA.objects.create(x_account=self.account, **DNA)

    def generate(self, *candidates, account=None):
        return services.generate_for_accounts([(account or self.account).pk], self.user, count=len(candidates), provider=FixedProvider(list(candidates)))[0]

    def test_quality_warnings_are_saved_but_never_block(self):
        item = self.generate(Candidate(format='TEXT', body='The last over of a close chase is the best part of any T20 game.', theme='Cricket', language='TINGLISH'))['items'][0]
        self.assertIn('LANGUAGE_MISMATCH', codes(item.validation_flags))
        self.assertEqual(item.status, 'DRAFT')
        # Fixing the text re-runs the checks.
        item = services.edit_item(item.pk, self.user, {'body': 'Last over lo tension aagadu asalu, TV mute chesi chusthunna.'})
        self.assertNotIn('LANGUAGE_MISMATCH', codes(item.validation_flags))
        self.assertEqual(services.approve_item(item.pk, self.user).status, 'APPROVED')

    def test_history_steers_the_next_prompt_and_flags_cross_account_openings(self):
        others = []
        for handle in ['hyd_foodie', 'tollywood_talk']:
            other = XAccount.objects.create(handle=handle, display_name=handle)
            ContentDNA.objects.create(x_account=other, **DNA)
            others.append(other)
            self.generate(Candidate(format='TEXT', body=f'Nobody talks about the {handle} side of match day.', theme='Cricket', language='ENGLISH'), account=other)
        provider = FixedProvider([Candidate(format='TEXT', body='Nobody talks about how slow the Uppal outfield is.', theme='Cricket', language='ENGLISH')])
        item = services.generate_for_accounts([self.account.pk], self.user, count=1, provider=provider)[0]['items'][0]
        self.assertIn('Openings other accounts used recently (do not start with these): "nobody talks about"', provider.requests[0].user_prompt)
        self.assertIn('COMMON_OPENING', codes(item.validation_flags))

    def test_history_is_read_with_a_fixed_number_of_queries(self):
        for i in range(30):
            ContentItem.objects.create(x_account=self.account, format='TEXT', body=f'Post number {i} about cricket', created_by=self.user)
        with self.assertNumQueries(3):
            history = quality.load_history(self.account.pk)
        self.assertEqual(len(history.recent_posts), 30)
