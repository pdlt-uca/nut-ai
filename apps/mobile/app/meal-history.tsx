import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, Image } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { mealHistory, type MealSummary } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type, MIN_TAP_TARGET } from '../src/theme/tokens'

export default function MealHistoryScreen() {
  const { date } = useLocalSearchParams<{ date: string }>()
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [meals, setMeals] = useState<MealSummary[]>([])

  useEffect(() => {
    if (!date) return
    let alive = true
    void (async () => {
      const history = await mealHistory(date)
      if (alive) setMeals(history)
    })()
    return () => {
      alive = false
    }
  }, [date])

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={space.md} style={styles.backButton}>
          <Icon name="back" size={24} color={theme.text} />
        </Pressable>
        <Text style={[type.title, { color: theme.text, flex: 1 }]}>
          Historial de comidas
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        {meals.length === 0 ? (
          <Text style={[type.body, { color: theme.textMuted, textAlign: 'center', marginTop: space.xl }]}>
            No hay comidas registradas para este día.
          </Text>
        ) : (
          meals.map((meal) => (
            <View key={meal.id} style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              {meal.photoUri ? (
                <Image source={{ uri: meal.photoUri }} style={styles.photo} />
              ) : (
                <View style={[styles.photoPlaceholder, { backgroundColor: theme.bgSunken }]}>
                  <Icon name="bowl" size={32} color={theme.border} />
                </View>
              )}
              <View style={styles.cardContent}>
                <View style={styles.cardHeader}>
                  <Text style={[type.bodyStrong, { color: theme.text, textTransform: 'capitalize' }]}>
                    {meal.slot}
                  </Text>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>
                    {meal.kcal} kcal
                  </Text>
                </View>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  {meal.ingredientCount} {meal.ingredientCount === 1 ? 'ingrediente' : 'ingredientes'}{' '}
                  (P: {meal.protein_g}g)
                </Text>
                <Text style={[type.body, { color: theme.text, marginTop: space.xs }]} numberOfLines={1}>
                  {meal.firstIngredient}{meal.ingredientCount > 1 ? ', ...' : ''}
                </Text>
                <Text style={[type.caption, { color: theme.textFaint, marginTop: space.xs }]}>
                  {new Date(meal.loggedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.md,
  },
  backButton: {
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -space.sm,
  },
  card: {
    flexDirection: 'row',
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  photo: {
    width: 100,
    height: 100,
  },
  photoPlaceholder: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardContent: {
    flex: 1,
    padding: space.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
})
